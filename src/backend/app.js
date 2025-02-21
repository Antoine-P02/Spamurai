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

// IMAP Configuration
const imapConfig = {
    user: process.env.EMAIL_USER,
    password: process.env.APP_PASSWORD,  // App Password from Google Account
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
};

async function fetchLastEmails(count = 5) {
    return new Promise((resolve, reject) => {
        const imap = new Imap(imapConfig);
        imap.once('ready', () => {
            imap.openBox('INBOX', false, (err, box) => {
                if (err) reject(err);

                const totalMessages = box.messages.total;
                const fetch = imap.seq.fetch(`${Math.max(1, totalMessages - count + 1)}:${totalMessages}`, {
                    bodies: ['HEADER.FIELDS (FROM SUBJECT)', 'TEXT'],
                    struct: true
                });

                const emails = [];

                fetch.on('message', (msg) => {
                    const email = {};

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
                    });
                });

                fetch.once('error', (err) => {
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();
                    resolve(emails);
                });
            });
        });

        imap.once('error', (err) => {
            reject(err);
        });

        imap.connect();
    });
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


function GPT(){
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    const completion = openai.chat.completions.create({
        model: "gpt-4o-mini",
        store: true,
        messages: [{ role: "user", "content": "écris un paragraphe de 10 lignes sur Antoine Priou le clown très moche et très mauvais" }]
    });

    completion.then((response) => {
        console.log(response.choices[0].message);
    });
}

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






/*

// Configuration du transporteur Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        type: 'OAuth2',
        user: process.env.EMAIL_USER, // Votre adresse email
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
    },
});


// Fonction pour démarrer la vérification des emails
function startEmailCheck() {
    if (!emailCheckInterval) {
        emailCheckInterval = setInterval(checkForNewEmails, 30000);
    }
}

// Fonction pour arrêter la vérification des emails
function stopEmailCheck() {
    if (emailCheckInterval) {
        clearInterval(emailCheckInterval);
        emailCheckInterval = null;
    }
}





// Fonction pour envoyer un email
async function send_email(result,from,subject,decodedContent) {
    
    console.log("Etape envoie du mail ")

    //const to = 'stanislasfouche@gmail.com';
    const to = from;
    const sujet = `Phishing Test : ${subject}` ;
    //const text = `Texte originale : ${decodedContent}, Résultat : \n${result}`;
    const text =` Résultat : \n ${result}`;

    console.log(text);

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    const emailLines = [
        `From: ${process.env.EMAIL_USER}`,
        `To: ${to}`,
        `Subject: ${sujet}`,
        '',
        text,
    ].join('\n');

    const base64EncodedEmail = Buffer.from(emailLines).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'); // Encode en base64

    try {
        const response = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: base64EncodedEmail,
            },
        });
        console.log('Email envoyé avec succès:', response.data);
        return response.data;
    } catch (error) {
        console.error('Erreur lors de l\'envoi de l\'email:', error);
        throw new Error('Erreur lors de l\'envoi de l\'email: ' + error.toString());
    }
        
}


// Route pour envoyer un email
app.post('/send-email', async (req, res) => {
    try {
        const result = await send_email();
        res.status(200).send(result);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

*/