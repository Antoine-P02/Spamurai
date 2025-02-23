require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const passport = require('passport');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const { send } = require('process');
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
    tlsOptions: { 
        rejectUnauthorized: false,
        enableTrace: true  // Enable connection tracing
    },
    connTimeout: 10000,    // Connection timeout (10 seconds)
    authTimeout: 5000,     // Auth timeout (5 seconds)
    debug: console.log     // Enable debug logging
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

async function fetchAllUnreadEmails() {
    console.log("Starting to fetch all unread emails...");
    
    const imap = new Imap({
        ...imapConfig,
        connTimeout: 10000,    // Reduced timeout
        authTimeout: 5000,     // Reduced timeout
        debug: (info) => console.log('IMAP Debug:', info)  // More detailed debugging
    });

    return new Promise((resolve, reject) => {
        let isConnectionEnded = false;

        const cleanup = () => {
            if (!isConnectionEnded) {
                isConnectionEnded = true;
                try {
                    imap.end();
                } catch (err) {
                    console.error('Error during cleanup:', err);
                }
            }
        };

        // Handle connection events
        imap.once('ready', () => {
            console.log("IMAP client is ready.");
            imap.openBox('INBOX', false, (err, box) => {
                if (err) {
                    console.error("Error opening INBOX:", err);
                    cleanup();
                    return reject(err);
                }

                console.log("INBOX opened successfully, searching for unread...");
                imap.search(['UNSEEN'], (err, results) => {
                    if (err) {
                        console.error("Error searching for unseen emails:", err);
                        cleanup();
                        return reject(err);
                    }

                    console.log(`Found ${results.length} unseen emails`);
                    if (results.length === 0) {
                        console.log("No unseen emails found");
                        cleanup();
                        return resolve([]);
                    }

                    const emails = [];
                    const fetch = imap.fetch(results, {
                        bodies: ['HEADER', 'TEXT'],
                        struct: true
                    });

                    fetch.on('message', (msg, seqno) => {
                        console.log(`Processing message #${seqno}`);
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
                            console.log(`Email #${seqno} processed:`, email);
                            imap.addFlags(email.uid, ['\\Seen'], (err) => {
                                if (err) console.error(`Error marking UID ${email.uid} as seen:`, err);
                            });
                        });
                    });

                    fetch.once('error', (err) => {
                        console.error("Fetch error:", err);
                        cleanup();
                        reject(err);
                    });

                    fetch.once('end', () => {
                        console.log("Fetch completed, cleaning up...");
                        cleanup();
                        resolve(emails);
                    });
                });
            });
        });

        console.log("before imap.once error");

        imap.once('error', (err) => {
            console.error("IMAP error:", err);
            cleanup();
            reject(err);
        });

        imap.once('end', () => {
            console.log("IMAP connection ended");
            isConnectionEnded = true;
        });

        console.log("Initiating IMAP connection...");
        try {
            imap.connect();
        } catch (err) {
            console.error("Connection error:", err);
            cleanup();
            reject(err);
        }
    });
}



function checkEmails(emails) {
    console.log('\n=== Lecture des nouveaux mails ===');
    emails.forEach(async (email, index) => {
        const { originalSender, forwarder } = getEmailSenders(email.headers, email.body);
        const object = email.headers.subject[0];
        const content = email.body;

        console.log("Original sender: " + originalSender + "/ Forwarded by: " + forwarder + " / Subject: " + object);

        if (originalSender === forwarder) { // Skip emails that are not forwarded
            console.log('Email non-forwarded, skipping...');
            return;
        }

        const completion = chatgptouille(originalSender, forwarder, object, content);
        await completion.then((result) => {

            if (result != false) {
                const message = result.choices[0].message.content; // Stocke le résultat dans une variable
                console.log(message);
                const text_answer = "🤖 SPAMURAI Phishing Analysis 🚀:\n" + object;
                send_email(message, forwarder, text_answer);  // Send response to the forwarder
            }
        });
    });
}

async function send_email(result, from, subject) {
    console.log("Envoi de l'email...");
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
        subject: `SPAMURAI Phishing Analysis : ${subject}`,
        text: result
    };
    console.log("about to try");

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

function extractContent(html) {
    const dom = new JSDOM(html);
    return dom.window.document.body.textContent || '';
}

async function chatgptouille(originalSender, forwarder, object, content) {
    mail_size = originalSender.length + object.length + extractContent(content).length;
    console.log("mail size : " + mail_size);

    if (mail_size > 15000) {
        send_email("⚠️ We're sorry" + forwarder + "to tell you but the mail you gave us from" + originalSender + "is too heavy and we don't have the computer power yet to analyse yet 🤖... but tune in, we're working on it and might be able to soon! 🚀",
            forwarder,
            "Issue with your query (mail too long)");
        return false;
    }

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    const response = openai.chat.completions.create({
        model: "gpt-4o-mini",
        store: false,
        messages: [
            { "role": "user", "content": `Peux-tu donner ton taux de certitude sur 100 si ce mail est du phishing ou non : - mail venant de l'adresse : ${originalSender} - objet du mail : ${object} - contenu : ${content} ` },
        ],
    });

    return response;

}

async function fetchNew() {
    console.log(" Relance du code ");

    try {
        const emails = fetchAllUnreadEmails();
        emails.then((result) => {
            console.log("Emails fetched successfully", result);

            if (result.length === 0) {
                console.log('Pas de nouveau mail');

            } 
            else {
                console.log("We have new emails");
                checkEmails(result);
            }
        }).catch((error) => {
            console.error('Error fetching emails in loop:', error);
        });
    }
    catch (error) {
        console.error('Error fetching emails:', error);
    }

}

function getEmailSenders(headers, content) {
    let originalSender = '';
    const forwarder = headers.from[0];

    // Look for Gmail's forwarded message marker
    if (content.includes('---------- Forwarded message ---------')) {
        // Parse the forwarded message headers
        const dePattern = /De\s*:\s*([^<]*<[^>]*>|[^\n]*)/i;
        const match = content.match(dePattern);

        if (match && match[1]) {
            originalSender = match[1].trim();
        } else {
            originalSender = forwarder;
        }
    } else {
        // Not a forwarded message
        originalSender = forwarder;
    }

    return { originalSender, forwarder };
}

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

app.post("/webhook/gmail", async (req, res) => {
    console.log("Gmail Webhook Received");
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
    await fetchNew();

    res.status(200).send("ok");
});


// Replace the setInterval with an API endpoint
app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/get/emails', async (req, res) => {
    try {
        await fetchNew();
        console.log("Emails fetched successfully");
        res.send("Emails fetched successfully");
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