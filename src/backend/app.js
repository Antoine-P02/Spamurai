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

const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,     // Your Google OAuth Client ID
    process.env.GOOGLE_CLIENT_SECRET, // Your Google OAuth Client Secret
    'https://spamurai-analysis.vercel.app/callback' // Your redirect URI
);


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

async function fetchLastEmails(count = 5) {
    return new Promise((resolve, reject) => {
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

// Function to check emails periodically
async function checkEmails() {
    try {
        const emails = await fetchLastEmails(5);
        console.log('\n=== Last 5 Emails ===');
        emails.forEach((email, index) => {
            console.log(`\nEmail ${index + 1}:`);
            console.log(`From: ${email.headers.from}`);
            console.log(`Subject: ${email.headers.subject}`);
            console.log(`Body: ${email.body.substring(0, 100)}...`);
        });
    } catch (error) {
        console.error('Error fetching emails:', error);
    }
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

const completion = openai.chat.completions.create({
    model: "gpt-4o-mini",
    store: true,
    messages: [{ role: "user", "content": "écris un paragraphe de 10 lignes sur Antoine Priou le clown très moche et très mauvais" }]
});

completion.then((response) => {
    console.log(response.choices[0].message);
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


// Fonction pour vérifier les nouveaux emails
async function checkForNewEmails() {
    if (!isLoggedIn) return; // Ne pas vérifier si l'utilisateur n'est pas connecté

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    try {
        const response = await gmail.users.messages.list({
            userId: 'me',
            labelIds: ['INBOX'],
            q: 'is:unread',
            maxResults: 5,
        });

        const messages = response.data.messages || [];

        if (messages.length > 0) {
            console.log('Nouveau(x) mail(s) :', messages.length); // Affiche "Nouveau mail" dans la console

            for (const message of messages) {
                const msg = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id,
                });

                const emailData = msg.data;
                const from = emailData.payload.headers.find(header => header.name === 'From').value;
                const subject = emailData.payload.headers.find(header => header.name === 'Subject').value;
                const content = emailData.payload.parts ? emailData.payload.parts[0].body.data : emailData.payload.body.data;
                const decodedContent = Buffer.from(content, 'base64').toString('utf-8');

                console.log(`De: ${from}`);
                console.log(`Objet: ${subject}`);
                console.log(`Contenu: ${decodedContent}`);

                const completion = chatgptouille(from,subject,decodedContent);
                await completion.then((result) => {
                    const message = result.choices[0].message.content; // Stocke le résultat dans une variable
                    send_email(message,from,subject,decodedContent);
                });


                // Marquer le message comme lu
                console.log("Modification en non-lu")
                await gmail.users.messages.modify({
                    userId: 'me',
                    id: message.id,
                    resource: {
                        removeLabelIds: ['UNREAD'],
                    },
                });
            }
        } else {
            console.log('Aucun nouveau mail');
        }
    } catch (error) {
        console.error('Erreur lors de la vérification des nouveaux emails:', error);
    }
}

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


*/



// Handle other errors
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('500: Something broke!');
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