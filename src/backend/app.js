require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config');
const Imap = require('imap');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
const app = express();
const PORT = config.port || 3000;

const { google } = require('googleapis');


// IMAP Configuration
const imapConfig = {
    user: process.env.EMAIL_USER,
    password: process.env.APP_PASSWORD,  // App Password from Google Account
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
};

const imap = new Imap(imapConfig);

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





// Function to check emails periodically
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

        const completion = chatgptouille(from,subject,body);
        await completion.then((result) => {
            const message = result.choices[0].message.content; // Stocke le résultat dans une variable
            //send_email(message,from,subject,decodedContent);
            console.log(message);
            send_email(message, from, subject);
        });


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


app.use(express.static(path.join(__dirname)));

/*
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
*/

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});


async function chatgptouille(email,object,content){
    const response = openai.chat.completions.create({
        model: "gpt-4o-mini",
        store: true,
        messages: [
            { "role": "user", "content": `Peux-tu donner ton taux de certitude sur 100 si ce mail est du phishing ou non : - email : ${email} - objet : ${object} - contenu : ${content}` },
        ],
    });
    
    return response;
    //return completion.then((result) => result.choices[0].message);
    
}   







// Handle other errors
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('500: Something broke!');
});


setInterval(testcheck, 20000);

// Replace the setInterval with an API endpoint
app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function testcheck(){
    console.log(" Relance du code ");

    try {
        const emails = await fetchAllUnreadEmails();

        if(emails.length === 0){
            //checkEmails(emails);
            console.log('Pas de nouveau mail');
    
        }else{ checkEmails(emails);}
    } 
    catch (error) {
        console.error('Error fetching emails:', error);
    }

}


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

app.get('/callback', async (req, res) => {
    const { code } = req.query;
    console.log("Debug :");
    console.log('GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID);
    console.log('GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET);
    console.log('GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL);


    if (!code) {
        return res.status(400).send('No code received');
    }

    try {
        // Exchange code for access token
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Store tokens securely (e.g., in a database or session)
        console.log('Access Token:', tokens.access_token);
        console.log('Refresh Token:', tokens.refresh_token);

        // Redirect the user back to your front-end (optional)
        res.redirect('/dashboard'); // Change this to your actual front-end page
    } catch (error) {
        console.error('Error exchanging code for token:', error);
        res.status(500).send('Authentication failed');
    }
});


// Handle 404 errors
app.use((req, res) => {
    res.status(404).send('404: Page not found');
});

