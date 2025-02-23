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

async function fetchAllUnreadEmails() {
    console.log("Starting to fetch all unread emails...");

    const imap = new Imap({
        ...imapConfig,
        connTimeout: 20000, // Connection timeout after x miliseconds
        authTimeout: 15000,  // Auth after x miliseconds
    });


    return new Promise((resolve, reject) => {
        const globalTimeout = setTimeout(() => {
            console.log("Global timeout reached - closing connection");
            imap.end();
            reject(new Error("Operation timed out after 30 seconds"));
        }, 30000);

        const cleanup = () => {
            clearTimeout(globalTimeout);
            imap.end();
        };

        imap.once('ready', () => {
            imap.openBox('INBOX', false, (err, box) => {
                if (err) {
                    console.error("❌ Error opening INBOX:", err);
                    cleanup();
                    return reject(err);
                }
                console.log("INBOX opened successfully.");

                imap.search(['UNSEEN'], (err, results) => {
                    if (err) {
                        console.error("❌ Error searching for unseen emails:", err);
                        cleanup();
                        return reject(err);
                    }
                    console.log(`Found ${results.length} unseen emails.`);

                    if (results.length === 0) {
                        console.log("ℹ️ No unseen emails found");
                        cleanup();
                        return resolve([]);
                    }

                    console.log(`📨 Found ${results.length} unseen emails`);
                    const emails = [];
                    let completed = 0;

                    const fetch = imap.fetch(results, {
                        bodies: ['HEADER', 'TEXT'],
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
                            completed++;

                            // Mark as seen
                            imap.addFlags(email.uid, ['\\Seen'], (err) => {
                                if (err) console.error(`Error marking UID ${email.uid} as seen:`, err);
                            });

                            if (completed === results.length) {
                                console.log("🎉 All messages processed");
                                cleanup();
                                resolve(emails);
                            }
                        });
                    });

                    fetch.once('error', (err) => {
                        console.error("❌ Fetch error:", err);
                        cleanup();
                        reject(err);
                    });
                });
            });
        });

        imap.once('error', (err) => {
            console.error("IMAP client error:", err);
            cleanup();
            reject(err);
        });

        imap.once('end', () => {
            console.log("IMAP connection ended");
        });

        // Connect with error handling
        try {
            console.log("Initiating IMAP connection...");
            imap.connect();
        } catch (err) {
            console.error("Connection error:", err);
            cleanup();
            reject(err);
        }
    });
}

async function checkEmails(emails) {
    console.log('\n=== Lecture des nouveaux mails ===');
    
    // Change forEach to for...of to properly handle async operations
    for (const email of emails) {
        try {
            const { originalSender, forwarder } = getEmailSenders(email.headers, email.body);
            const object = email.headers.subject[0];
            const content = email.body;

            console.log("Original sender: " + originalSender + "/ Forwarded by: " + forwarder + " / Subject: " + object);

            if (originalSender === forwarder) {
                console.log('Email non-forwarded, skipping...');
                continue;
            }

            console.log("Calling chatGPT analysis...");
            const completion = await analysis_LLM(originalSender, forwarder, object, content);
            
            if (completion !== false) {
                const message = completion.choices[0].message.content;
                console.log("Analysis result:", message);

                try {
                    console.log("#" + message + "#");
                    const prediction_result = parseInt(message);
                    const treshold = 90;

                    if (prediction_result > treshold) {
                        console.log("Phishing detected");
                        const returned_text = "⚠️ We're sorry" + forwarder + "to tell you but the mail you gave us from" + originalSender + "is a phishing attempt 🚨. Please be careful and do not click on any links or download any attachments. We recommend you to delete this email immediately. Stay safe! 🛡️";
                        await send_email(returned_text, forwarder, object);
                    } 
                    else {
                        console.log("Email is not a phishing attempt");
                        const returned_text = "🎉 Great news" + forwarder + "the mail you gave us from" + originalSender + "is not a phishing attempt 🎣. You can safely proceed with this email. If you have any other questions or concerns, feel free to ask! 🤖";
                        await send_email(returned_text, forwarder, object);
                    }
                    
                }
                catch (error) {
                    console.error("Error parsing LLM response:", error);
                }

                
                
            }
        } catch (error) {
            console.error("Error processing email:", error);
            // Continue with next email even if one fails
        }
    }
    console.log("=== Email processing completed ===");
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
        subject: `SPAMURAI Phishing Analysis : ${subject}`,
        text: result
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

function extractContent(html) {
    const dom = new JSDOM(html);
    return dom.window.document.body.textContent || '';
}

async function analysis_LLM(originalSender, forwarder, object, content) {
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
            {
                "role": "user", "content": `You are a highly skilled cybersecurity expert with years of experience in threat detection and email security. The stakes for this analysis are extremely high—any oversight could lead to severe financial losses, data breaches, or compromised personal information. Your task is to analyze the following forwarded email thoroughly to determine whether it is a phishing attempt.

You must take into account several crucial factors and reason through each element with the utmost care. Your analysis should be meticulous, comprehensive, and methodical but only use them for reasoning and do not explain your reasoning in the answer you are gonna give.

Original Sender Analysis:

Analyze the sender’s email address for suspicious elements.
Check for unusual domain names, excessive numbers, strange characters, or misspellings of trusted organizations (e.g., "g00gle.com" instead of "google.com").
Keep in mind that not all no-reply accounts are malicious—legitimate companies often use these.
Subject Line Evaluation:

Examine the subject for urgency tactics (e.g., “Immediate Action Required”, “Account Suspension Notice”).
Look for emotional manipulation, financial bait, or threats that push the recipient to act quickly without thinking.
Content Examination:

Check for spelling, grammatical errors, or awkward phrasing often found in phishing emails.
Detect any request for sensitive information like passwords, Social Security numbers, banking details, or security codes.
Identify suspicious links or attachments—check if the displayed URL matches the actual destination when hovered over.
Psychological Manipulation Detection:

Be aware of fear-based messaging or false authority (e.g., emails claiming to be from CEOs, government officials, or banks).
Contextual Red Flags:

Determine if the email is unexpected or irrelevant to the recipient’s typical communications.
Evaluate if the content seems out of character for the supposed sender, especially if it's from a trusted source.
Urgency and Consequences:

Detect pressure tactics implying severe consequences if immediate action isn’t taken.
Treat this analysis with the highest level of scrutiny—consider every possibility, as if a successful phishing attack could result in catastrophic damage. Ensure that all suspicious elements are identified and evaluated thoroughly. \nInputs : \n- originalSender ${originalSender} \n- subject : ${object} \n- content ${content}  At the end of your analysis, YOU MUST RETURN NOTHING ELSE BUT a score out of 100 indicating how likely this email is to be a phishing attempt—where 0 means "definitely not phishing" and 100 means "certainly phishing."` },
        ],
    });

    return response;

}

async function fetchNew() {
    console.log(" Relance du code ");

    try {
        const emails = await fetchAllUnreadEmails();
        console.log("Emails fetched successfully" + emails);

        if (emails.length === 0) {
            console.log('Pas de nouveau mail');

        } else {
            console.log("We have new emails");
            await checkEmails(emails);
        }
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

    try {
        // Send immediate response to Gmail

        // Make HTTP request to our GET endpoint
        const fetch = await import('node-fetch');
        const response = await fetch.default("https://spamurai-analysis.vercel.app/api/get/emails");

        if (!response.ok) {
            throw new Error(`GET request failed: ${response.status}`);
        }

        console.log("Email processing triggered via GET endpoint");
    } catch (error) {
        console.error("Error triggering email processing:", error);
    }
    res.status(200).send("ok");
});


// Replace the setInterval with an API endpoint
app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/get/emails', async (req, res) => {
    try {
        await fetchNew();
        res.send("Emails fetched successfully");
        //const emails = await fetchAllUnreadEmails();
        //console.log("Emails fetched successfully" + emails);
        //res.send("Emails fetched successfully" + emails);
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