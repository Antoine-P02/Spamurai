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

// Check emails every 30 seconds
setInterval(checkEmails, 30000);

// Initial check
checkEmails();


app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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

// Handle 404 errors
app.use((req, res) => {
    res.status(404).send('404: Page not found');
});

// Handle other errors
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('500: Something broke!');
});

// Replace the setInterval with an API endpoint
app.get('/', async (req, res) => {
  try {
    const emails = await fetchLastEmails(5);
    res.json(emails);
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});