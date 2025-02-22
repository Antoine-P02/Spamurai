require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

const path = require('path');
const config = require('./config');
const Imap = require('imap');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');

const PORT = config.port || 4040;
const app = express();


app.use(passport.initialize());


// IMAP Configuration
const imapConfig = {
    user: process.env.EMAIL_USER,
    password: process.env.APP_PASSWORD,  // App Password from Google Account
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
};

function formatDateWithOffset(isoDateString) {
    const date = new Date(isoDateString);
    date.setHours(date.getHours() + 1); // Add 1 hour for France timezone

    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
    const year = date.getFullYear();

    return `${hours}:${minutes} ${day}/${month}/${year}`;
}

async function fetchNew() {
    try {
        const emails = await fetchAllUnreadEmails();

        if (emails.length === 0) {
            console.log('Pas de nouveau mail');
        }
        else {
            checkEmails(emails);
        }
    }
    catch (error) {
        console.error('Error fetching emails:', error);
    }
}

async function fetchAllUnreadEmails() {
    const imap = new Imap(imapConfig);

    return new Promise((resolve, reject) => {
        imap.once('ready', () => {
            imap.openBox('INBOX', false, (err, box) => {
                if (err) {
                    imap.end();
                    return reject(err);
                }

                imap.search(['UNSEEN'], (err, results) => {
                    if (err) {
                        imap.end();
                        return reject(err);
                    }

                    if (results.length === 0) {
                        imap.end();
                        return resolve([]);
                    }

                    const emails = [];
                    const fetch = imap.fetch(results, {
                        bodies: ['HEADER.FIELDS (FROM SUBJECT)', 'TEXT'],
                        struct: true
                    });

                    fetch.on('message', (msg, seqno) => {
                        let email = { seqno };

                        msg.on('attributes', (attrs) => {
                            email.uid = attrs.uid;
                        });

                        msg.on('body', (stream, info) => {
                            let buffer = '';
                            stream.on('data', (chunk) => {
                                buffer += chunk.toString('utf8');
                            });
                            stream.on('end', () => {
                                if (info.which === 'TEXT') {
                                    email.body = buffer;
                                } else {
                                    email.headers = Imap.parseHeader(buffer);
                                }
                            });
                        });

                        msg.once('end', () => {
                            emails.push(email);
                            imap.addFlags(email.uid, ['\\Seen'], (err) => {
                                if (err) console.error(`Erreur marquage UID ${email.uid}:`, err);
                            });
                        });
                    });

                    fetch.once('error', (err) => {
                        imap.end();
                        reject(err);
                    });

                    fetch.once('end', () => {
                        imap.end();
                        resolve(emails);
                    });
                });
            });
        });

        imap.once('error', (err) => {
            imap.end();
            reject(err);
        });

        imap.connect();
    });
}

function checkEmails(emails) {
    console.log('\n=== Lecture des nouveaux mails ===');

    emails.forEach(async (email, index) => {
        from = email.headers.from
        subject = email.headers.subject;
        body = email.body;

        console.log(`\nEmail ${index + 1}:`);
        console.log(`From: ${email.headers.from}`);
        console.log(`Subject: ${email.headers.subject}`);
        console.log(`Subject: ${email.body}`);

        const completion = analysis_LLM(from, subject, body);
        await completion.then((result) => {
            const message = result.choices[0].message.content; // Stocke le résultat dans une variable
            console.log(message);
            send_email(message, from, subject);
        });
    });
}

async function analysis_LLM(email, object, content) {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    const response = openai.chat.completions.create({
        model: "gpt-4o-mini",
        store: true,
        messages: [
            { "role": "user", "content": `Peux-tu donner ton taux de certitude sur 100 si ce mail est du phishing ou non : - email : ${email} - objet : ${object} - contenu : ${content}` },
        ],
    });

    return response;
}

async function send_email(result, from, subject) {

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.APP_PASSWORD
        }
    });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: from,
        subject: `Phishing Test : ${subject}`,
        text: ` Résultat : \n ${result}`
    };

    try {
        const response = await transporter.sendMail(mailOptions);
        console.log('Email envoyé avec succès:', response);
        return response;
    } catch (error) {
        console.error('Erreur lors de l\'envoi de l\'email:', error);
        throw new Error('Erreur lors de l\'envoi de l\'email: ' + error.toString());
    }

}


app.use(
    bodyParser.json({
        limit: "50mb",
        verify: (req, _, buf) => {
            req.rawBody = buf;
        },
    })
);

passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: process.env.GOOGLE_CALLBACK_URL,
        },
        (accessToken, refreshToken, profile, done) => {
            console.log("Access Token: ", accessToken);
            console.log("Refresh Token: ", refreshToken);
            console.log("Profile: ", profile);
            done(null, profile);
        }
    )
);


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


app.get("/auth/google",
    passport.authenticate("google", {
        scope: [
            "profile",
            "email",
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.labels",
        ],
    })
);

app.get("/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/login" }),
    (req, res) => {
        res.redirect("/");
    }
);

app.post("/webhook/gmail", (req, res) => {
    console.log("Gmail Webhook Received");
    res.status(200).send("ok");

    console.log("Mail received at: ", formatDateWithOffset(req.body.message.publishTime));

    const { message } = req.body;

    if (!message || !message.data) {
        console.log("No message data found");
        return;
    }

    // Decode the Base64 encoded message data
    const encodedMessage = message.data;
    const decodedMessage = JSON.parse(
        Buffer.from(encodedMessage, "base64").toString("utf-8")
    );
    console.log("Decoded Message: ", decodedMessage, "\n\n");
    fetchNew();

    

});


// Replace the setInterval with an API endpoint
app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/get/emails', async (req, res) => {
    try {
        const emails = await fetchLastEmails(5);
        console.log("Emails fetched successfully" + emails);
        res.send("Emails fetched successfully" + emails);
    } 
    catch (error) {
        console.error('Error fetching emails:', error);
        res.send("Error fetching emails : " + error.message);
    }
});

app.get('/api/post/emails', async (req, res) => {
    try {
        const result = await send_email("allo", process.env.EMAIL_USER, "test1");
        console.log("Email sent successfully");
        res.send("Email sent successfully" + result.response);
    } catch (error) {
        console.error('Error sending email:', error);
        res.send("Error sending email : " + error.message);
    }
});

app.post('/api/get/notif', async (req, res) => {
    try {
        const emails = await fetchLastEmails(5);
        console.log("omgggggggg" + emails);
        res.send("omgggggggg" + emails);
    }
    catch (error) {
        console.error('big ff:', error);
        res.send("big ff : " + error.message);
    }
});

// Handle other errors
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('500: Something broke!');
});

// Handle 404 errors
app.use((req, res) => {
    res.status(404).send('404: Page not found');
});


