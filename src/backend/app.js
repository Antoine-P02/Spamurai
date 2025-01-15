require('dotenv').config(); 
const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config');
const { google } = require('googleapis');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
const app = express();
const PORT = config.port || 3000;

app.use('/favicon.ico', express.static(path.join(__dirname, '../public/favicon.ico')));
app.use(session({
    secret: 'your_secret_key', // Change this to a random secret key
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const APIKEY = process.env.APIKEY;

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const openai = new OpenAI({
    apiKey: process.env.APIKEY,
});

const completion = openai.chat.completions.create({
    model: "gpt-4o-mini",
    store: true,
    messages: [
        { "role": "user", "content": "écris un paragraphe de 10 lignes sur Antoine Priou le clown très moche et très mauvais" },
    ],
});

completion.then((result) => console.log(result.choices[0].message));

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

/*
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
*/

let isLoggedIn = false; // Variable pour suivre l'état de connexion
let emailCheckInterval; // Variable pour stocker l'intervalle

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


app.get('/login', (req, res) => {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/gmail.send'],
    });
    isLoggedIn = true; 
    startEmailCheck()
    console.log("Connexion réussi")
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const { code } = req.query;
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    req.session.tokens = tokens; // Store tokens in session
    res.redirect('/protected_area');
});


app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Bienvenue sur Spamurai</title>
            </head>
            <body>
                <h1>Whats up la team</h1>
                <a href="/login">
                    <button id="loginButton">Login with Google</button>
                </a>
            </body>
        </html>
    `);
});

app.get('/protected_area', async (req, res) => {
    if (!req.session.tokens) {
        return res.redirect('/login');
    }

    oAuth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    try {
        const response = await gmail.users.messages.list({
            userId: 'me',
            labelIds: ['INBOX'],
            maxResults: 5,
        });

        const messages = response.data.messages || [];
        const emailData = [];

        for (const message of messages) {
            const msg = await gmail.users.messages.get({
                userId: 'me',
                id: message.id,
            });
            emailData.push(msg.data.snippet);
        }

        res.send(`
            <h1>Your Emails:</h1>
            <ul>
                ${emailData.map(email => `<li>${email}</li>`).join('')}
            </ul>
            <a href="/logout">
                <button id="logoutButton">Logout</button>
            </a>
        `);
    } catch (error) {
        console.error('Error fetching emails:', error);
        res.status(500).send('Error fetching emails');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
    isLoggedIn = false;
    stopEmailCheck();
    console.log("Déconnexion réussi")
});


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});




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

