const express = require('express')
const path = require('path')
const PORT = process.env.PORT || 5000
const https = require('https')
const compression = require('compression');
const session = require('express-session');
const fs = require('fs');
const mimelib = require("mimelib");
const { convert } = require('html-to-text');
const simpleParser = require('mailparser').simpleParser;
const teamUtils = require("./views/pages/generate-teams-utils.js");
const passport = require('passport');
const prettier = require("prettier");
const RateLimit = require('express-rate-limit');

// By default, the client will authenticate using the service account file
// specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable and use
// the project specified by the GOOGLE_CLOUD_PROJECT environment variable. See
// https://github.com/GoogleCloudPlatform/google-cloud-node/blob/master/docs/authentication.md
// These environment variables are set automatically on Google App Engine
const Firestore = require('@google-cloud/firestore');
const firestore = new Firestore({
  projectId: 'tensile-spirit-360708',
  keyFilename: './keyfile.json',
});
// Create express session store to persist sessions in a Firestore collection "express-sessions"
const {FirestoreStore} = require('@google-cloud/connect-firestore');

// this happens automatically, but add a message in the log as a reminder
var environment = process.env.ENVIRONMENT;
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log("RUNNING LOCALLY WITH FIREBASE EMULATOR:", process.env.FIRESTORE_EMULATOR_HOST, "Environment:", environment);
}

var monthDateNumericFormat = new Intl.DateTimeFormat('en', { month: '2-digit' });
const localeDateOptions = {
  weekday: 'short',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};
var bankHolidaysCache = {};
var bankHolidaysCacheLastRefresh = new Date();
var bankHolidaysMaxCacheSecs = 86400; // 1 day
var attendanceMapByYearCache = {};
var rawDatabaseCache = {};
const PLAYER_UNIQUE_FILTER = "PLAYER_UNIQUE_FILTER_TYPE";
const PLAYER_LOG_FILTER = "PLAYER_LOG_FILTER_TYPE";
const COST_PER_GAME = 4;
const EMAIL_TITLE_POSTFIX = " [Footie, Goodwin, 6pm Mondays]";
const MAIL_SUBSCRIPTION_STATUS_SUBSCRIBED = 2
const MAIL_SUBSCRIPTION_STATUS_CONFIRMING = 1
const MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED = 0
const EMAIL_TYPE_ALL_PLAYERS = 0;
const EMAIL_TYPE_ADMIN_ONLY = 1;
const EMAIL_TYPE_TEAMS_ADMIN = 2;

/* Email functionality */
const GOOGLE_MAIL_FROM_NAME = (process.env.GOOGLE_MAIL_FROM_NAME) ? process.env.GOOGLE_MAIL_FROM_NAME : "Phil Roffe <philroffe@gmail.com>";

// set up rate limiter: maximum of 50 requests per minute (normal), 5000 requests per minute (test)
var rateLimitPerWindowMs = 1000;
if (process.env.FIRESTORE_EMULATOR_HOST) {
  // in local test so increase rate limit
  rateLimitPerWindowMs = 100000; 
}
var limiter = RateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: rateLimitPerWindowMs, // max requests per windowMs
  handler: (request, response, next, options) => {
    if (request.rateLimit.used === request.rateLimit.limit + 1) {
      // onLimitReached code here
      console.log(`Rate limit reached for IP: ${request.ip}`, request.rateLimit.limit);
    }
    response.status(options.statusCode).send(options.message)
  },
});

const app = express();
app.use(compression());
app.use(limiter); // apply rate limiter to all requests

// enable google auth
var authRouter = require('./routes/auth');
var lastLocationBeforeLogin = '/';

app.use(express.static(path.join(__dirname, 'public')))
.use(express.urlencoded({ extended: true }))
.use(express.json())
.set('views', path.join(__dirname, 'views'))
.set('view engine', 'ejs')

.use(session({
  store: new FirestoreStore({
    dataset: firestore,
    kind: 'express-sessions',
  }),
  secret: process.env.SESSION_SECRET,
  resave: false, // don't save session if unmodified
  saveUninitialized: false, // don't create session until something stored
  cookie: {
    // Session expires after 8 hrs of inactivity.
    expires: 8*60*60*1000
  }
}))
.use(passport.authenticate('session'))
.use(function(req, res, next) {
  var msgs = req.session.messages || [];
  res.locals.messages = msgs;
  res.locals.hasMessages = !! msgs.length;
  req.session.messages = [];
  next();
})

// if running locally, allow a fake login for testing purposes
if (process.env.FIRESTORE_EMULATOR_HOST) {
  var fakeUser = {"id":123456, "username":"fake-user", "_id":"fake", "name":"Fake User"};
  function middleware(req, res, next) {
    if (req && req.session && req.session.user_tmp) {
      req.user = req.session.user_tmp;
    }
    if (next) { next() }
  }
  function route(req, res) {
    req.session = req.session || {};
    req.session.user_tmp = fakeUser;
    res.redirect('/');
  } 
  app.use(middleware)
  app.get('/auth/fake', route)
}

async function getUserRoles(user) {
  var userRoles = "anonymous";
  if (user && user.email) {
    userRoles = "authenticated";
    // check admin user list from preferences
    var preferencesDoc = await firestore.collection("ADMIN").doc("_preferences").get();
    var preferences = preferencesDoc.data();
    //console.log(preferences, user)
    if (preferences && preferences.fullAdminEmails && preferences.fullAdminEmails.includes(user.email)) {
      userRoles = "fulladmin";  
    }
  }
  return userRoles;
}

async function clearExpiredExpressSessions() {
  const sessionsCollection = firestore.collection("express-sessions");
  const allSessionDocs = await sessionsCollection.get();
  allSessionDocs.forEach(doc => {
    var data = JSON.parse(doc.data().data);
    if (!data.cookie || !data.cookie.expires || new Date(data.cookie.expires) < new Date()) {
      //console.log("Deleting session...", doc.id, data.cookie.expires);
      firestore.collection("express-sessions").doc(doc.id).delete();
    }
  })
}

// simple check to ensure a path is local - security measure to prevent Server-side URL redirect
function isLocalUrl(path) {
  try {
    return (new URL(path, "https://example.com").origin === "https://example.com");
  } catch (e) {
    return false;
  }
}

app.use('/', authRouter)
.get('/login', function(req, res, next) {
  // a hack that won't scale past a single user logging in at a time
  // store the referer on login attempt, to allow redirect after successful login
  lastLocationBeforeLogin = (req.headers.referer) ? req.headers.referer : '/admin';
  //override if the url contains a place to redirect
  lastLocationBeforeLogin = (req.query.redirect && isLocalUrl(req.query.redirect)) ? req.query.redirect : lastLocationBeforeLogin;
  res.redirect(302, "/login/federated/google");
})
.get('/loggedin', function(req, res, next) {
  // a hack that won't scale past a single user logging in at a time
  res.redirect(302, lastLocationBeforeLogin);
})
.get('/error', function(req, res, next) {
  teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, "WARNING: Denied attempt to login from unknown user:", JSON.stringify(req.user));
  res.redirect(301, '/');
})

.get('/', (req, res) => res.render('pages/index', { pageData: JSON.stringify({"environment": environment, "user": req.user})} ))
.get('/privacy-policy', (req, res) => res.render('pages/privacy-policy', { pageData: JSON.stringify({"environment": environment})} ))
.post('/create-payments-for-month', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log('Got /create-payments-for-month POST:', ip, JSON.stringify(req.body));


  var openFinancialYear = 0; 
  var preferencesDoc = await firestore.collection("ADMIN").doc("_preferences").get();
  var preferences = preferencesDoc.data();
  if (preferences && preferences.openFinancialYear) {
    openFinancialYear = preferences.openFinancialYear;
  }
  console.log("openFinancialYear", openFinancialYear)

  var gameMonth = req.body.gameMonth;
  var gameYear = req.body.gameYear;
  var gameId = gameYear + "-" + gameMonth + "-01";
  try {
    var gamesCollectionId = "games_" + gameId;
    console.log('Setting month status to closed:', gamesCollectionId);
    const docRef = firestore.collection(gamesCollectionId).doc("_attendance");

    var existingDoc = await docRef.get();
    var attendanceData = existingDoc.data();

    var savedata = { "status": "closed" };
    await docRef.set(savedata, { merge: true });

    // now request payment for all game attendance
    var mondaysDates = teamUtils.mondaysInMonth(Number(gameMonth), Number(gameYear));  //=> [ 7,14,21,28 ]
    for (var weekNumber = 0; weekNumber <= 5; weekNumber ++) {
      console.log("week", weekNumber)
      var gameDay = mondaysDates[weekNumber];
      if (gameDay < 10) {
        gameDay = "0" + gameDay;
      }
      var thisDate = gameYear + "-" + gameMonth + "-" + gameDay;

      var playerList = attendanceData[weekNumber].players;
      if (playerList) {
        Object.keys(playerList).forEach(await function(playerName) {
          // check a real player (not the scores) and that the player actually played
          if ((playerName != "scores") && (playerList[playerName] > 0)) {
            var gameWeek = gameId + "_" + weekNumber;

            //const playerLedgerDocRef = firestore.collection("PAYMENTS").doc(playerName);
            const playerLedgerDocRef = firestore.collection("OPEN_LEDGER").doc(playerName);
            var playerTransactionSavedata = {};
            playerTransactionSavedata["charge_" + thisDate] = { "amount": (COST_PER_GAME * -1), "financialYear": openFinancialYear };
            console.log('Adding game cost:', playerName, thisDate, JSON.stringify(playerTransactionSavedata));
            playerLedgerDocRef.set(playerTransactionSavedata, { merge: true });
          }
        });
        // now also store the pitch charge
        const playerClosedLedgerDocRef = firestore.collection("CLOSED_LEDGER").doc("Admin - Pitch Costs");
        var playerTransactionName = "charge_pitch_" + thisDate;
        var pitchTransactionSavedata = {};
        pitchTransactionSavedata[playerTransactionName] = { "amount": preferences.costOfPitch, "gameDate": thisDate, "payeeName": "Admin Pitch Organiser"};
        //console.log('Adding PITCH CHARGE:', thisDate, JSON.stringify(pitchTransactionSavedata));
        playerClosedLedgerDocRef.set(pitchTransactionSavedata, { merge: true });
      }
    }
    res.json({'result': 'OK'})
  } catch (err) {
    console.error(err);
    res.send({'result': err});
  }
})
.get('/admin-payments-ledger', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT FOOTIE-ADMIN GET FROM:', ip, req.body);

  try {
    //console.log('Generating TEAMS page with data for date: ', req.query.date);
    //var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
    var rowdata = {};
    var openFinancialYear = 0; // 0 gets all games, overridden in preferences DB
    // allow cron to be disabled by setting app preferences
    var preferencesDoc = await firestore.collection("ADMIN").doc("_preferences").get();
    var preferences = preferencesDoc.data();
    if (preferences && preferences.openFinancialYear) {
      openFinancialYear = preferences.openFinancialYear;
    }
    //openFinancialYear = 2024;
    console.log("openFinancialYear", openFinancialYear)

    const inboundEmailsCollection = firestore.collection("INBOUND_EMAILS");
    const allInboundEmailsDocs = await inboundEmailsCollection.get();
    var inboundEmails = {};
    var delDoc = [];
    allInboundEmailsDocs.forEach(doc => {
      var key = doc.id;
      var data = doc.data();
      inboundEmails[key] = data;
    })
    rowdata.inboundEmails = inboundEmails;
    
    // read the list of players and aliases
    var playerAliasMaps = await getDefinedPlayerAliasMaps();
    rowdata.playerAliasMaps = playerAliasMaps;

    // get all daata - used to generate the costs and kitty
    rowdata.allCollectionDocs = await getAllDataFromDB();
    //console.log(rowdata.allCollectionDocs);
    // filter the data for the active accounting period
    var filterData = { ...rowdata.allCollectionDocs }
    for (const thisDataId in filterData) {
      if (thisDataId.startsWith("games_") && !thisDataId.includes(openFinancialYear)) {
        delete filterData[thisDataId];
      }
    }
    rowdata.allCollectionDocs = filterData;


    // read the completed payments ledger
    const closedLedgerCollection = firestore.collection("CLOSED_LEDGER");
    const allClosedLedgerDocs = await closedLedgerCollection.get();
    var closedLedgers = {};
    allClosedLedgerDocs.forEach(doc => {
      var key = doc.id;
      var data = doc.data();
      // filter the data for the active accounting period
      var filterData = { ...data }
      for (const thisDataId in filterData) {
        if (thisDataId.startsWith("charge_")) {
          if (filterData[thisDataId].financialYear != openFinancialYear) {
            delete filterData[thisDataId];
          }
        }
        if (thisDataId.startsWith("payment_")) {
          console.log("WHAT IS WRONG WITH: ", thisDataId, filterData[thisDataId]);
          // TODO: Check chargeId = must be null
          if (filterData[thisDataId].financialYear != openFinancialYear && filterData[thisDataId].chargeId && filterData[thisDataId].chargeId.length > 0) {
            delete filterData[thisDataId];
          }
        }
      }
      closedLedgers[key] = filterData;
    })
    rowdata.closedLedgers = closedLedgers;

    // read the open payments ledger
    const openLedgerCollection = firestore.collection("OPEN_LEDGER");
    const allOpenLedgerDocs = await openLedgerCollection.get();
    var openLedgers = {};
    allOpenLedgerDocs.forEach(doc => {
      var key = doc.id;
      var data = doc.data();
      // filter the data for the active accounting period
      var filterData = { ...data }
      for (const thisDataId in filterData) {
        if (filterData[thisDataId].financialYear != openFinancialYear) {
          delete filterData[thisDataId];
        }
      }
      openLedgers[key] = filterData;
    })
    rowdata.openLedgers = openLedgers;


    
    // combine database data with supplimentary game data and render the page
    var nextMonday = getDateNextMonday();
    var pageData = { 'data': rowdata, 'nextMonday': nextMonday.toISOString(), "environment": environment };
    
    if (req.isAuthenticated()) {
      console.log("User is logged in: ", JSON.stringify(req.user));
      pageData.user = req.user;
    }

    // render the page and pass some json with stringified value
    res.render('pages/admin-payments-ledger', { pageData: JSON.stringify(pageData) });
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.post('/services/save-preferences', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT SAVE-PREFERENCES POST FROM EMAIL:', ip, req.body);

  try {
    // now save the updated data
    var updatedPreferences = req.body;
    // TODO - validate and sanitise the preferences before saving
    const preferencesDocRef = firestore.collection("ADMIN").doc("_preferences");
    await preferencesDocRef.set(updatedPreferences, { merge: true });
    res.json({'result': 'OK'})
  } catch (err) {
    console.error(err);
    res.sendStatus(400);
  }
})
.post('/services/payment', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT PAYMENT POST FROM EMAIL:', ip, req.body);
  var emailDate = new Date(req.body.email_sent_date.split(' at')[0]);
  var transactionDate = new Date(req.body.transaction_date);
  var transactionId = req.body.transaction_id;
  var payeeName = req.body.payee_name.replace(/:/, '');
  var amountReceived = req.body.amount_received;
  var amount = Number(amountReceived.split(' ')[0].replace(/£/, ''));

  // save the details
  var saveSuccess = receivePaymentEmail(payeeName, amount, transactionId, transactionDate);
  if (saveSuccess) {
    res.json({'result': 'OK'})
  } else {
    res.sendStatus(400);
  }
})
.post('/services/payment-manual', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT PAYMENT-MANUAL POST:', ip, req.body);

  if (req.isAuthenticated()) {
    console.log("User is logged in: ", JSON.stringify(req.user));
  } else {
    console.log("User NOT logged in - rejecting");
    res.sendStatus(400);
    return;
  }

  try {
    // validate the details
    var action = req.body.action;
    var payeeName = req.body.payeeName;
    var amount = Number(req.body.amount);
    var transactionType = req.body.transactionType;
    var transactionId = req.body.transactionId;
    var transactionDate = new Date(req.body.transactionDate);

    // save the details
    var saveSuccess = false;
    if (transactionType == "payment") {
      if (action == "ADD") {
        if (transactionDate && transactionId && payeeName && amount) {
          saveSuccess = receivePaymentEmail(payeeName, amount, transactionId, transactionDate);
        }
      } else if (action == "REFUND") {
        if (transactionId) {
          console.log('REFUNDING...:', transactionId);
          saveSuccess = await refundPayment(transactionId);
        }
      }
    } else if (transactionType == "charge") {
        console.log('Charge...:', payeeName, transactionDate);
    }

    if (saveSuccess) {
      res.json({'result': 'OK'})
    } else {
      console.error("ERROR: Failed to save manual payment - discarding", action, payeeName, amount, transactionId, transactionDate);
      res.sendStatus(400);
    }
    
  } catch (err) {
    console.error(err);
    res.json({'result': err})
  }
})

.post('/services/payment-admin-cost', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT PAYMENT-ADMIN-COST POST:', ip, req.body);

  if (req.isAuthenticated()) {
    console.log("User is logged in: ", JSON.stringify(req.user));
  } else {
    console.log("User NOT logged in - rejecting");
    res.sendStatus(400);
    return;
  }

  if (!Array.isArray(req.body)) {
    console.log("Invalid request body - expected an array");
    res.sendStatus(400);
    return;
  }

  try {
    // validate the details
    var saveSuccess = true;
    var errorMessage = [];
    for (i=0; i<req.body.length; i++) {
      var payeeName = req.body[i].payeeName;
      var amount = Number(req.body[i].amount);
      var transactionId = req.body[i].transactionId;
      var transactionDate = new Date(req.body[i].transactionDate);

      if (transactionDate && transactionId && payeeName && amount) {

        try {
          var dayString = "" + transactionDate.getDate();
          if (dayString.length == 1) {
            dayString = "0" + dayString;
          }
          var monthString = "" + (transactionDate.getMonth()+1);
          if (monthString.length == 1) {
            monthString = "0" + monthString;
          }
          // read list of outstanding payments for the player
          const playerClosedLedgerDocRef = firestore.collection("CLOSED_LEDGER").doc(payeeName);
          var thisDate = transactionDate.getFullYear() + "-" + monthString + "-" + dayString;
          var playerTransactionName = "charge_pitch_" + thisDate + "_" + transactionId;
          var playerClosedLedgerDoc = await playerClosedLedgerDocRef.get();
          if (playerClosedLedgerDoc.data() && playerClosedLedgerDoc.data()[playerTransactionName]) {
            console.warn("transaction already exists, skipping to avoid double counting...", playerTransactionName);
            errorMessage[i] = req.body[i];
            saveSuccess = false;
          }
          var playerTransactionSavedata = {};
          playerTransactionSavedata[playerTransactionName] = req.body[i];
          console.log('Adding PAYMENTS:', payeeName, thisDate, JSON.stringify(playerTransactionSavedata));
          playerClosedLedgerDocRef.set(playerTransactionSavedata, { merge: true });
        } catch (err) {
          console.error(err);
          errorMessage[i] = req.body[i];
          saveSuccess = false;
        }
      }
    }

    if (saveSuccess) {
      res.json({'result': 'OK'})
    } else {
      console.error("ERROR: Failed to save manual admin cost - discarding", errorMessage);
      res.sendStatus(400);
    }

  } catch (err) {
    console.error(err);
    res.json({'result': err})
  }
})
.post('/services/goal-scorers', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT GOAL-SCORERS POST FROM EMAIL:', ip, req.body);

  try {
    var gameDate = new Date(req.body.gameDate);
    //scorerMap = scorers: { "Phil R": 1, "Rich M": 2 }
    var scorerMap = req.body.scorers;

    var currentGameWeekIndex = getGameWeekMonthIndex(gameDate);
    var gameMonth = monthDateNumericFormat.format(gameDate);
    var gameYear = gameDate.getFullYear();
    var gamesCollectionId = "games_" + gameYear + "-" + gameMonth + "-01";
    console.log("gamesCollectionId", gamesCollectionId)

    // allow cron to be disabled by setting app preferences
    var attendanceDoc = await firestore.collection(gamesCollectionId).doc("_attendance").get();
    var attendanceData = attendanceDoc.data();
    if (!attendanceData) { attendanceData = {}; }
    //console.log("PRE attendanceData", attendanceData);

    var scorerMapTeam1 = {};
    var scorerMapTeam2 = {};

    for (const player in scorerMap) {
      var noOfGoals = scorerMap[player];
      var teamNumber = attendanceData[currentGameWeekIndex][player];
      if (teamNumber == 1) {
        scorerMapTeam1[player] = Number(noOfGoals);
      } else {
        scorerMapTeam2[player] = Number(noOfGoals);
      }
      console.log("scorer", player, noOfGoals, teamNumber);
    }
    attendanceData[currentGameWeekIndex]["scores"]["team1scorers"] = scorerMapTeam1; 
    attendanceData[currentGameWeekIndex]["scores"]["team2scorers"] = scorerMapTeam2;
    //console.log("POST attendanceData", attendanceData);

    // now save the updated data
    const docRef = firestore.collection(gamesCollectionId).doc("_attendance");
    await docRef.set(attendanceData, { merge: true });
    res.json({'result': 'OK'})
  } catch (err) {
    console.error(err);
    res.sendStatus(400);
  }
})
.post('/services/teams', async (req, res) => {
  // DEPRECATED - endpoint for mailparser, now replaced by google appengine inbound email capability
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT TEAMS POST FROM EMAIL: (MAILPARSER)', ip, req.body);
  var emailDate = new Date(req.body.Email_Sent_Date.split(' at')[0]);
  //var emailSubjectGameDate = new Date(req.body.Subject_Game_Date + " " + emailDate.getFullYear());
  var redTeam = req.body.Red_Team;
  var blueTeam = req.body.Blue_Team;
  var redTeamPlayers = redTeam.split('\n');
  var blueTeamPlayers = blueTeam.split('\n');

  //calc date - use the next Monday after the email date
  var gameDate = getDateNextMonday(emailDate);
  // save the details
  var saveSuccess = saveTeamsAttendance(gameDate, redTeamPlayers, blueTeamPlayers);

  if (saveSuccess) {
    res.json({'result': 'OK'});
  } else {
    res.sendStatus(400);
  }
})
.post('/services/generate-payment-history-link', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT SERVCE: GENERATE PAYMENT-HISTORY LINK GET FROM:', ip, req.body);

  try {
    var email = req.body.email;

    // look up the player name from the email
    var aliasesDoc = await firestore.collection("ADMIN").doc("_aliases").get();
    var aliasesData = aliasesDoc.data();
    var foundKey = "";
    Object.keys(aliasesData).sort().forEach(function(key) {
      if (aliasesData[key].email && aliasesData[key].email.toLowerCase() == email.toLowerCase()) {
        foundKey = key;
      }
    });

    // [5 Oct 2025] temporary admin event just to keep track of the new feature (delete at end of year)
    teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, "Payment history request", email + "=" + foundKey);

    var token;
    if (foundKey) {
      token = aliasesData[foundKey].token;
      if (!token) {
        console.log("No token found so generated new one for email:", email)
        const crypto = require('crypto');
        function generateToken() {
          return crypto.randomBytes(32).toString('hex'); // 64-char random string
        }
        token = generateToken();
        // now save the token
        aliasesData[foundKey].token = token;
        await firestore.collection("ADMIN").doc("_aliases").set(aliasesData); 
      }
      console.log("Got token:", email, token)

      // now send the email
      var emailSubject = "View your payment history [Footie, Goodwin, 6pm Mondays]";
      var pollLink = "https://tensile-spirit-360708.nw.r.appspot.com/payment-history?token=" + token;
      var emailBody = "Hi " + foundKey + "," +
        "<br><br>The following link contains your unique token to view your payment details." +
        "<br><br>Click the link to see your charges and payments history:<br>" + pollLink + "<br>";
      var mailOptions = {
        from: GOOGLE_MAIL_FROM_NAME,
        to: email,
        subject: emailSubject,
        html: emailBody
      };
      // now send the email
      var emailResult = teamUtils.sendEmailToList(mailOptions, req.hostname);
    } else {
      console.log("Failed to send email link - not a valid email:", email);
    }
    res.json({'result': 'OK'});
  } catch (err) {
    console.error(err);
    res.json({'result': 'OK'}); //always send ok
  }
})
.post('/services/modify-mailinglist', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT SERVCE: MODIFY MAILINGLIST GET FROM:', ip, req.body);

  try {
    var details = {};
    details.date = new Date();
    details.name = req.body.fullname;
    details.email = req.body.email;
    details.optIn = Boolean(req.body.subscribeType);
    details.sourceIp = ip;

    // store the audit record of the add/remove request
    const docRef = await firestore.collection("MAILING_LIST_AUDIT").doc(details.date.toISOString() + "_" + details.email);
    await docRef.set(details);
    delete details.sourceIp;

    // now actually perform the add/remove
    var success = await addRemoveEmailSubscription(details, req.hostname);
    if (success) {
      res.json({'result': 'OK'});
    } else {
      console.error("ERROR - failed to add/Remove email subscription");
      res.sendStatus(400);
    }
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.get('/payment-history', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT PAYMENT_HISTORY GET FROM:', ip, req.body, req.query.token);
  try {
    // now need to check if confirming subscriptionStatus
    var token = req.query.token;
    var paymentData = {};

    if (token != undefined) {
      // read the list of players and aliases
      var playerAliasMaps = await getDefinedPlayerAliasMaps();
      var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];
      var playerEmailMaps = await getDefinedPlayerEmailMaps();
      var playerToEmailMap = playerEmailMaps["playerToEmailMap"];
      var playerToTokenMap = playerEmailMaps["playerToTokenMap"];

      var officialPlayerName = Object.keys(playerToTokenMap).find(key => playerToTokenMap[key] === token);
      if (officialPlayerName) {
        //console.log("Found matching player:", officialPlayerName);
        paymentData.token = token;
        paymentData.name = officialPlayerName;
        paymentData.email = playerToEmailMap[officialPlayerName];

        // get closed ledger
        const playerClosedLedgerDocRef = firestore.collection("CLOSED_LEDGER").doc(officialPlayerName);
        var playerClosedLedgerDoc = await playerClosedLedgerDocRef.get();
        paymentData.closedLedger = playerClosedLedgerDoc.data();
        if (!paymentData.closedLedger) {
          paymentData.closedLedger = {};
        }
        // get open ledger
        const playerOpenLedgerDocRef = firestore.collection("OPEN_LEDGER").doc(officialPlayerName);
        var playerOpenLedgerDoc = await playerOpenLedgerDocRef.get();
        paymentData.openLedger = playerOpenLedgerDoc.data();
        if (!paymentData.openLedger) {
          paymentData.openLedger = {};
        }

        // get any payment emails not yet processed
        const emailCollection = firestore.collection("INBOUND_EMAILS");
        const allEmailDocs = await emailCollection.get();
        var unprocessedPayments = [];
        allEmailDocs.forEach(async doc => {
          var emailDetails = doc.data();
          // now convert html to plain text and try to parse the email
          const options = { wordwrap: 10000 };
          const html = emailDetails.data;
          const text = convert(html, options);
          //console.log("Plain HTML", text);

          var parsedData = teamUtils.parsePaypalEmail(text);
          if (emailDetails.parsedData && emailDetails.parsedData.payeeName ) {
            var payeeName = emailDetails.parsedData.payeeName;
            var officialPayee = teamUtils.getOfficialNameFromAlias(payeeName, aliasToPlayerMap);
            if (officialPayee && officialPayee == officialPlayerName) {
              unprocessedPayments.push(emailDetails.parsedData);
            }
          }
        });
        paymentData.unprocessedPayments = unprocessedPayments;
      }
    }

    var pageData = { paymentData: paymentData, "environment": environment };
    res.render('pages/payment-history', { pageData: JSON.stringify(pageData)} );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.get('/mailing-list', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT MODIFY MAILINGLIST GET FROM:', ip, req.body);
  try {
    // now need to check if confirming subscriptionStatus
    var code = Number(req.query.code);
    var thisPlayerAliasMap;
    // lookup confirmation code and update the subscriptionStatus as appropriate
    if (code) {
      var aliasesDoc = await firestore.collection("ADMIN").doc("_aliases").get();
      var aliasesMap = aliasesDoc.data();
      var playerConfirmedKey;
      Object.keys(aliasesMap).sort().forEach(function(key) {
        if (aliasesMap[key].code == code) {
          thisPlayerAliasMap = aliasesMap[key];
          if (aliasesMap[key].subscriptionStatus != MAIL_SUBSCRIPTION_STATUS_SUBSCRIBED) {
            aliasesMap[key].subscriptionStatus = MAIL_SUBSCRIPTION_STATUS_SUBSCRIBED;
            playerConfirmedKey = key;
            console.log("CONFIRMED MAILING LIST CODE:", thisPlayerAliasMap);
          } else {
            console.log("FOUND MAILING LIST CODE BUT ALREADY SUBSCRIBED :", thisPlayerAliasData);
          }
        }
      });
      console.log("Checking mailing-list conf code:", code, "Match found?", playerConfirmedKey);
      if (playerConfirmedKey) {
        // save the updated alias map
        await firestore.collection("ADMIN").doc("_aliases").set(aliasesMap);
        var title = "[Mailing List CONFIRMED] " + aliasesMap[playerConfirmedKey].email + " [Footie, Goodwin, 6pm Mondays]";
        var subject = aliasesMap[playerConfirmedKey].email + "\n" + aliasesMap[playerConfirmedKey].subscriptionStatus;
        teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, title, subject);
      }
      if (!thisPlayerAliasMap) {
        console.log("ERROR FINDING MAILING LIST CODE:", code);
      }
      var pageData = { code: code, thisPlayerAliasMap: thisPlayerAliasMap, "environment": environment };
      res.render('pages/mailing-list-confirmation', { pageData: JSON.stringify(pageData)} );
    } else {
      var pageData = { code: code, thisPlayerAliasMap: thisPlayerAliasMap, "environment": environment };
      res.render('pages/mailing-list', { pageData: JSON.stringify(pageData)} );
    }
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.post('/_ah/mail/payment@tensile-spirit-360708.appspotmail.com', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT /_ah/mail/payment@... PAYMENT POST FROM EMAIL:', ip, req.body);
  try {
    var body;
    var streamData = "";
    await req.on('readable', function() {
      streamData += req.read();
    });
    req.on('end', function() {
      // done so convert from quoted-printable mime type
      body = mimelib.decodeQuotedPrintable(streamData);
      var parsedData = {};
      // store the data for future processing
      var docNamePrefix = "PAYMENT_ERROR_EMAIL";
      if (body.includes("no-reply@sheffield.ac.uk")) {
        docNamePrefix = "PAYMENT_PITCH_EMAIL";
      } else if (body.includes("service@paypal.co.uk")) {
        docNamePrefix = "PAYMENT_PAYPAL_EMAIL";
        try {
          // convert html to plain text and try to parse the email
          const options = { wordwrap: 10000 };
          const text = convert(body, options);
          //console.log("Plain Text", text);
          parsedData = teamUtils.parsePaypalEmail(text);
        } catch (err) {
          // do nothing
        }
      }
      var emailDetails = { "parsed_status": "NEW", "type": docNamePrefix, "parsedData": parsedData, "data": body}
      const docRef = firestore.collection("INBOUND_EMAILS").doc(docNamePrefix + "_" + new Date().toISOString());
      docRef.set(emailDetails);
    });
    res.json({'result': 'OK'});
  } catch (err) {
    console.error(err);
    res.json({'result': err})
  }
})
.post('/_ah/mail/teams@tensile-spirit-360708.appspotmail.com', async (req, res) => {
  console.log('Got /_ah/mail/teams@... with Content-Type:', req.get('Content-Type'));

  // read the list of players and aliases
  var playerAliasMaps = await getDefinedPlayerAliasMaps();
  var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];

  try {
    var streamData = "";
    await req.on('readable', function() {
      streamData += req.read();
    });
    await req.on('close', function() {
      /* Commented out - only needed for debugging
      // Convert from quoted-printable mime type
      //var body = mimelib.decodeQuotedPrintable(streamData);
      //console.log("BODY", body);
      // store the data for future processing
      var emailDetails = { "parsed_status": "NEW", "data": body}
      var emailDocname = "TEAMS_EMAIL_" + new Date().toISOString();
      const docRef = firestore.collection("INBOUND_EMAILS").doc(emailDocname);
      docRef.set(emailDetails);
      */

      var options = {};
      simpleParser(streamData, options, (err, mail) => {
        if (err) throw err;
        //console.log(mail);

        // get the email date (Date: Fri, 1 Sep 2023 11:26:16 +0100)
        var dateLine = mail.text.split("Date:")[1].split(":")[0].split(", ")[1].split(" at")[0].trim();
        console.log("Dateline in email:", dateLine)
        var emailDate = new Date(dateLine + " 18:00");
        // get the game date from the subject
        // Subject: Fwd: 2 Players Needed - Mon 21 Aug [Footie, Goodwin, 6pm Mondays]
        var subjectLine = mail.text.split("Subject:")[1].split("[Footie, Goodwin, 6pm Mondays]")[0];
        var gameDateLine = subjectLine.split("Mon ")[1];
        var gameDate = new Date(gameDateLine + " " + emailDate.getFullYear() + " 18:00");
        //console.log("Game date in email:", emailDate, gameDate)

        // find the start of the player list
        var allPlayersRaw = mail.text.toUpperCase().split("REDS")[1];
        // find the end of the player list
        allPlayersRaw = allPlayersRaw.split("CHEERS")[0];
        allPlayersRaw = allPlayersRaw.split("THANKS")[0];
        allPlayersRaw = allPlayersRaw.split("STANDBY")[0];
        //console.log("Line:", allPlayersRaw)
        var allPlayers;
        var redPlayerMap = {};
        var bluePlayerMap = {};
        var scores = {};
        if (allPlayersRaw) {
          // get the first 20 lines (should be max 6 reds, 6 blues plus headers and blank lines etc)
          allPlayers = allPlayersRaw.split("\n").slice(0,20);
          //console.log("Line:", allPlayers)

          // loop through all players
          var currentTeam = 1;
          var team1goals = 0;
          var team2goals = 0;
          for (i=0; i<allPlayers.length; i++) {
            var cleanName = allPlayers[i].replace(/^>+/g, '').replace(/<br>/g, '').trim().replace(/^\d/, '')
              .replace(/ \d$/, '').replace(/^\./g, '').replace(/^/g, '').replace(/\*+/i, '').split(" (")[0].trim();

            var hasLastNumber = allPlayers[i].match(/\d+$/); // last number in string
            var goalsScored = (hasLastNumber) ? Number(hasLastNumber[0]) : 0;

            if (cleanName == "BLUES") {
              // switch to using the blues map for subsequent players
              currentTeam = 2;
            }
            var officialPlayerName = teamUtils.getOfficialNameFromAlias(cleanName, aliasToPlayerMap);
            if (officialPlayerName) {
              if (currentTeam == 1) {
                redPlayerMap[officialPlayerName] = goalsScored;
                team1goals += Number(goalsScored);
              } else {
                bluePlayerMap[officialPlayerName] = goalsScored;
                team2goals += Number(goalsScored);
              }
            }
            //console.log("Line", i, cleanName, officialPlayerName, goalsScored)
          }
          if ((team1goals > 0) || (team2goals > 0)) {
            scores = { "team1goals": team1goals, "team2goals": team2goals};
            // now calculate which team won
            scores.winner = 0;
            if (team1goals > team2goals) {
              scores.winner = 1;
            } else if (team1goals < team2goals) {
              scores.winner = 2;
            }
          }
          console.log("gameDate", gameDate);
          console.log("redPlayerMap", redPlayerMap);
          console.log("bluePlayerMap", bluePlayerMap);
          console.log("scores", scores);
        }
        
        // save the details
        var saveSuccess = saveTeamsAttendance(gameDate, redPlayerMap, bluePlayerMap, scores);
        if (saveSuccess) {
          console.log("SUCCESS: Saved teams from email:", gameDateLine);
        } else {
          console.error("ERROR: FAILED TO SAVE TEAMS FROM EMAIL:");
        }
      });
    });
    res.json({'result': 'OK'});
  } catch (err) {
    console.error(err);
    res.json({'result': err})
  }
})
.post('/logging', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.error('CLIENT_ERROR:', ip, req.body);
  res.json({'result': 'OK'});
  })
.get('/teams', async (req, res) => {
      try {
        console.log('Generating TEAMS page with data for date: ', req.query.date);
        var requestedDate = new Date();
        if (req.query.date) {
          requestedDate = new Date(req.query.date);
        }
        console.log('Generating TEAMS page with data for date: ', requestedDate);
        var rowdata = await queryDatabaseAndBuildPlayerList(requestedDate);
        
        // read the list of aliases
        var playerAliasMaps = await getDefinedPlayerAliasMaps();
        rowdata.playerToAliasMap = playerAliasMaps["playerToAliasMap"];
        rowdata.aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];
        // read the list of emails
        var playerEmailMaps = await getDefinedPlayerEmailMaps();
        rowdata.playerToEmailMap = playerEmailMaps["playerToEmailMap"];
        rowdata.activeEmailList = playerEmailMaps["activeEmailList"];

        var allAttendanceData = await queryDatabaseAndCalcGamesPlayedRatio(requestedDate);
        rowdata.allAttendanceData = allAttendanceData;

        var nextMonday = getDateNextMonday(requestedDate);
        var calcPaymentsFromDate = nextMonday;
        if (req.query.date) {
          calcPaymentsFromDate = req.query.date;
        }
        var outstandingPayments = await queryDatabaseAndBuildOutstandingPayments(calcPaymentsFromDate);
        rowdata.outstandingPayments = outstandingPayments;
        console.log('OUTSTANDING PAYMENTS data' + JSON.stringify(outstandingPayments));
        
        // read the teams from the playersPreviewData
        rowdata.playersPreviewData = await getGameWeekPreviewTeams();
        
        // combine database data with supplimentary game data and render the page
        var pageData = { 'data': rowdata, 'nextMonday': nextMonday.toISOString(), "environment": environment };
        if (req.isAuthenticated()) {
          console.log("User is logged in: ", JSON.stringify(req.user));
          pageData.user = req.user;
        }
        res.render('pages/poll-generate-teams', { pageData: JSON.stringify(pageData) });
      } catch (err) {
        console.error(err);
        res.send("Error " + err);
      }
    })
.get('/stats-ticker', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('Stats-ticker access from IP:' + ip + " with user-agent:" + req.get('User-Agent'));
  // Check if cache needs clearing
  /*var diffSeconds = (new Date().getTime() - bankHolidaysCacheLastRefresh.getTime()) / 1000;
  if (diffSeconds > maxCacheSecs) {
    attendanceMapByYearCache = {};
    console.log('CLEARED Attendance CACHE as diffSeconds was:' + diffSeconds);
  }*/

  try {
    var attendanceMapByYear = {};
    if (Object.keys(attendanceMapByYearCache).length > 0) {
      console.log('Retrieved STATS from cache:' + req.query.date);
      attendanceMapByYear = attendanceMapByYearCache;
    } else {
      for (var year = 2019; year < 2024; year ++) {
        attendanceMapByYear[year] = {};
        for (var month = 1; month < 13; month ++) {
          var monthString = "" + month;
          if (monthString.length == 1) {
            monthString = "0" + month;
          }
          var currentDate = year + "-" + monthString + "-01";
          console.log('Building STATS page for date:' + currentDate);
          var rowdata = await queryDatabaseAndBuildPlayerList(currentDate);
          if (rowdata.attendance && Object.keys(rowdata.attendance).length > 0) {
            attendanceMapByYear[year][monthString] = rowdata.attendance;
          }
        }
      }
    }
    attendanceMapByYearCache = attendanceMapByYear;


    // read the list of players and aliases
    var playerAliasMaps = await getDefinedPlayerAliasMaps();

    var rowdata = {};
    rowdata.attendanceByYear = attendanceMapByYear;
    rowdata.playerAliasMaps = playerAliasMaps;
    console.log('rowdata', JSON.stringify(rowdata));

    // combine database data with any additional page data
    var pageData = { data: rowdata, "environment": environment };

    res.render('pages/stats', { pageData: pageData } );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.get('/stats', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('Stats access from IP:' + ip + " with user-agent:" + req.get('User-Agent'));

  try {
    var rowdata = {};
    rowdata.playerAliasMaps = await getDefinedPlayerAliasMaps();
    rowdata.allCollectionDocs = await getAllDataFromDB();
    //console.log('rowdata', JSON.stringify(rowdata));

    // discard some uneccesary data
    delete rowdata.allCollectionDocs.INBOUND_EMAILS;
    delete rowdata.allCollectionDocs.OPEN_LEDGER;
    delete rowdata.allCollectionDocs.CLOSED_LEDGER;
    delete rowdata.allCollectionDocs.MAILING_LIST_AUDIT;

    var tabName = "";
    if (req.query.tab) {
      tabName = req.query.tab;
    }

    //var allCollectionDocs = JSON.parse(allCollectionDocsJson);

    // combine database data with any additional page data
    var pageData = { data: rowdata, selectTab: tabName, "environment": environment };
    res.render('pages/stats-all', { pageData: JSON.stringify(pageData) });
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.get('/poll', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('Poll access from IP:' + ip + " with user-agent:" + req.get('User-Agent'));
  // Check if cache needs clearing
  var diffSeconds = (new Date().getTime() - bankHolidaysCacheLastRefresh.getTime()) / 1000;
  if (diffSeconds > bankHolidaysMaxCacheSecs) {
    bankHolidaysCache = {};
    console.log('CLEARED CACHE as diffSeconds was:' + diffSeconds);
  }

  try {
    var nextMonday = getDateNextMonday();
    var calcPaymentsFromDate = nextMonday;
    if (req.query.date) {
      if (req.query.date.match('^20[0-9][0-9]-(0[1-9]|1[012])-(01)$')) {
        calcPaymentsFromDate = req.query.date;
      } else {
        console.log('WARNING: Invalid date - should be the first of a month in yyyy-mm-dd format). Redirecting', req.query.date);
        res.redirect(302, "/poll");
        return;
      }
    }

    console.log('Rendering POLL page with data' + req.query.date);
    var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
    //console.log('SCORES POLL page with data' + JSON.stringify(rowdata.scores));

    var outstandingPayments = await queryDatabaseAndBuildOutstandingPayments(calcPaymentsFromDate);
    rowdata.outstandingPayments = outstandingPayments;
    //console.log('OUTSTANDING PAYMENTS data' + JSON.stringify(outstandingPayments));

    var tabName = "";
    if (req.query.tab) {
      tabName = req.query.tab;
    }

    // get the latest bank holidays if not already cached
    if (bankHolidaysCache && Object.keys(bankHolidaysCache).length === 0) {
      try {
        bankHolidaysCache = await downloadPage("https://www.gov.uk/bank-holidays.json");
        console.log("Got NEW bank holidays: " + Object.keys(bankHolidaysCache).length);
        clearExpiredExpressSessions(); // clear expired express-sessions too
      } catch (err) {
        bankHolidaysCache = {};
        console.log("ERROR retrieving NEW bank holidays - proceeding without them...", err)
      }
    } else {
      console.log("Using CACHED bank holidays: " + Object.keys(bankHolidaysCache).length)
    }
    // combine database data with any additional page data
    var pageData = { data: rowdata, bankHolidays: bankHolidaysCache, selectTab: tabName, "environment": environment  };

    var aliasesData = {};
    if (req.isAuthenticated()) {
      console.log("User is logged in: ", JSON.stringify(req.user));
      pageData.user = req.user;
      //console.log('Generating ALIASES page with data');
      var aliasesDoc = await firestore.collection("ADMIN").doc("_aliases").get();
      aliasesData = aliasesDoc.data();
      if (!aliasesData) {
        aliasesData = {};
      }
    }

    // allow cron to be disabled by setting app preferences
    var attendanceDoc = await firestore.collection("games_2025-01-01").doc("_attendance").get();
    var attendanceData = attendanceDoc.data();
    if (!attendanceData) { attendanceData = {}; }
    //console.log("PRE attendanceData", attendanceData);

    pageData.aliasesData = aliasesData;

    res.render('pages/poll', { pageData: JSON.stringify(pageData) });
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.get('/poll-log', async (req, res) => {
      try {
        console.log('Listing recent LOG of poll entries');
        var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date, PLAYER_LOG_FILTER);
        var nextMonday = getDateNextMonday();
        // combine database data with supplimentary game data and render the page
        var pageData = { data: rowdata, nextMonday: nextMonday.toISOString(), "environment": environment };
        res.render('pages/poll-log', { pageData: pageData} );
      } catch (err) {
        console.error(err);
        res.send("Error " + err);
      }
    })
.post('/save-availability', async (req, res) => {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log('Got /save-availability POST:', ip, JSON.stringify(req.body));

    var gameMonth = req.body.gameMonth;
    var gameYear = req.body.gameYear;
    var playerName = req.body.playerName;
    var playerAvailability = req.body.playerAvailability;
    var saveType = req.body.saveType;
    var originalPlayerName = (req.body.originalPlayerName === undefined) ? "" : req.body.originalPlayerName;
    
    gameId = gameYear + "-" + gameMonth + "-01";
    var timestamp = new Date();
    const gamedetails_new = { "gameid": gameId, "timestamp": timestamp, 
    "playerName": playerName, "playerAvailability": playerAvailability, 
    "saveType": saveType, "originalPlayerName": originalPlayerName, "source_ip": ip };

    var eventDetails = convertAvailibilityToDates(gameMonth, gameYear, playerAvailability);
    teamUtils.sendAdminEvent(EMAIL_TYPE_TEAMS_ADMIN, "[Player Change Event] " + playerName + EMAIL_TITLE_POSTFIX, playerName + "\n" + eventDetails);

    console.log('Inserting DB game data:', JSON.stringify(gamedetails_new));
    try {
      var gamesCollectionId = "games_" + gameId;
      const docRef = firestore.collection(gamesCollectionId).doc(playerName + "_" + timestamp.toISOString());
      await docRef.set(gamedetails_new);

      // check if preview of teams has already been generated
      var nextMonday = getDateNextMonday(new Date());
      var playersPreviewData = await getGameWeekPreviewTeams();
      var previewDate = new Date(playersPreviewData.gameWeek);
      if (teamUtils.datesAreOnSameDay(previewDate, nextMonday)) {
        // preview teams already generated - check if player was added/removed from this week
        var currentGameWeekIndex = getGameWeekMonthIndex(nextMonday);
        var playerAvailableThisWeek = playerAvailability[currentGameWeekIndex];
        var teamsUpdateNeeded = false;

        var allCurrentPlayers = playersPreviewData.redPlayers.concat(playersPreviewData.bluePlayers, playersPreviewData.standbyPlayers);
        var playerInPreviewList = allCurrentPlayers.indexOf(playerName);
        if (playerInPreviewList == -1) {
          // player not in list
          if (playerAvailableThisWeek) {
            // player is available so add them
            teamsUpdateNeeded = true;
            if (playersPreviewData.redPlayers.length > playersPreviewData.bluePlayers.length) {
              // uneven teams so add to the blues
              playersPreviewData.bluePlayers.push(playerName);
            } else if (playersPreviewData.redPlayers.length < playersPreviewData.bluePlayers.length) {
              // uneven teams so add to the reds
              playersPreviewData.redPlayers.push(playerName);
            } else {
              // even teams so check if space
              if (playersPreviewData.standbyPlayers.length == 0) {
                // even teams so add to standby
                playersPreviewData.standbyPlayers.push(playerName);
              } else {
                if (playersPreviewData.redPlayers.length < 6) {
                  // add existing standby to reds, and new player to blues
                  playersPreviewData.redPlayers.push(playersPreviewData.standbyPlayers.shift());
                  playersPreviewData.bluePlayers.push(playerName);
                } else {
                  // add to standby
                  playersPreviewData.standbyPlayers.push(playerName);
                }
              }
            }
          }
        } else {
          // player is on the current list
          if (!playerAvailableThisWeek) {
            // but is no-longer available list so remove them
            teamsUpdateNeeded = true;
            // check standby
            var index = playersPreviewData.standbyPlayers.indexOf(playerName);
            if (index > -1) playersPreviewData.standbyPlayers.splice(index, 1);
            // check reds
            var index = playersPreviewData.redPlayers.indexOf(playerName);
            if (index > -1) {
              playersPreviewData.redPlayers.splice(index, 1);
              if (playersPreviewData.standbyPlayers.length > 0) {
                // auto replace with standby member
                playersPreviewData.redPlayers.push(playersPreviewData.standbyPlayers.shift());
              }
            }
            // check blues
            var index = playersPreviewData.bluePlayers.indexOf(playerName);
            if (index > -1) {
              playersPreviewData.bluePlayers.splice(index, 1);
              if (playersPreviewData.standbyPlayers.length > 0) {
                // auto replace with standby member
                playersPreviewData.bluePlayers.push(playersPreviewData.standbyPlayers.shift());
              }
            }
          }
        }

        if (teamsUpdateNeeded) {
          // save updated teams
          playersPreviewData.status = "Saved";
          await firestore.collection("ADMIN").doc("GameWeekPreview").set(playersPreviewData);
          // send an admin email to inform that draft teams need updating
          //teamUtils.sendAdminEvent(EMAIL_TYPE_TEAMS_ADMIN, "[DRAFT TEAMS UPDATE NEEDED Event] " + playerName + EMAIL_TITLE_POSTFIX, playerName + "\n" + eventDetails);
          var emailPrefix = playerName + " - Playing?: " + playerAvailableThisWeek;
          sendTeamsPreviewEmail(playersPreviewData, emailPrefix);
        }
      }

      res.json({'result': 'OK'})
    } catch (err) {
      console.error(err);
      res.send({'result': err});
    }
  })
.post('/save-week-attendance', async (req, res) => {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log('Got /save-week-attendance POST:', ip, JSON.stringify(req.body));
    
    if (!req.isAuthenticated) {
      console.warn('WARNING: attempting to save WEEK ATTENDANCE but user not logged in.  Denied.');
      res.status(401).send({'result': 'Denied. User not logged in...'});
      return;
    }

    var weekNumber = req.body.weekNumber;
    var gameDay = req.body.gameDay;
    var gameMonth = req.body.gameMonth;
    var gameYear = req.body.gameYear;
    var playersAttended = req.body.playersAttended;
    var scores = req.body.scores;
    var status = req.body.status;
    var saveType = req.body.saveType;

    var timestamp = new Date();
    var attendanceDetails = { "month": gameYear + "-" + gameMonth, "timestamp": timestamp, 
     "saveType": saveType, "source_ip": ip};

    attendanceDetails[weekNumber] = {};
    attendanceDetails[weekNumber].players = playersAttended;
    attendanceDetails[weekNumber].scores = scores;
    attendanceDetails[weekNumber].status = status;

    teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, "[Week Attendance Change Event] " + gameYear + "-" + gameMonth + 
      " (" + weekNumber + ")", JSON.stringify(attendanceDetails, null, 2));

    console.log('Inserting DB data:', JSON.stringify(attendanceDetails));
    try {
      var gamesCollectionId = "games_" + gameYear + "-" + gameMonth + "-01";
      const docRef = firestore.collection(gamesCollectionId).doc("_attendance");
      var existingDoc = await docRef.get();
      if (!existingDoc.data()) {
        console.log('CREATING:', JSON.stringify(attendanceDetails));
        await docRef.set(attendanceDetails);
      } else {
        console.log('UPDATING:', JSON.stringify(attendanceDetails));
        await docRef.update(attendanceDetails);
      }

      //now invalidate any caches
      attendanceMapByYearCache = {}; // clear the stats cache - needs recalculating next time it reloads

      res.json({'result': 'OK'})
    } catch (err) {
      console.error(err);
      res.send({'result': err});
    }
  })
.post('/save-payment', async function (req, res) {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.log('Got /save-payment POST:', ip, JSON.stringify(req.body));

  if (!req.isAuthenticated) {
    console.warn('WARNING: attempting to save PAYMENT but user not logged in.  Denied.');
    res.status(401).send({'result': 'Denied. User not logged in...'});
    return;
  }

  var gameMonth = req.body.gameMonth;
  var gameYear = req.body.gameYear;
  var paydetails = req.body.paydetails;

  console.log('Inserting DB data:', JSON.stringify(paydetails));
  try {
    var gamesCollectionId = "games_" + gameYear + "-" + gameMonth + "-01";
    const docRef = firestore.collection(gamesCollectionId).doc("_attendance");
    var savedata = { "paydetails": paydetails };
    await docRef.set(savedata, { merge: true });
    res.json({'result': 'OK'})
  } catch (err) {
    console.error(err);
    res.send({'result': err});
  }
 })
.post('/services/payment-email-admin', async function (req, res) {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.log('Got /payment-email-admin POST:', ip, JSON.stringify(req.body));

  if (!req.isAuthenticated) {
    console.warn('WARNING: attempting to save PAYMENT but user not logged in.  Denied.');
    res.status(401).send({'result': 'Denied. User not logged in...'});
    return;
  }

  var key = req.body.key;
  var type = req.body.type;
  var action = req.body.action;

  try {
    if (type == "INBOUND_EMAIL" && action == "DELETE") {
      console.log('Deleting:', type, key);
      await firestore.collection("INBOUND_EMAILS").doc(key).delete();
      res.json({'result': 'OK'})
    } else {
      console.error('Deleting:', type, key);
      res.send({'result': "Error. Incorrect type or action"}); 
    }
  } catch (err) {
    console.error(err);
    res.send({'result': err});
  }
 })
.post('/admin-save-aliases', async (req, res) => {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log('Got /admin-save-aliases POST:', ip, JSON.stringify(req.body));

    if (!req.isAuthenticated) {
      console.warn('WARNING: attempting to save ALIASES but user not logged in.  Denied.');
      res.status(401).send({'result': 'Denied. User not logged in...'});
      return;
    }

    var aliasesData = req.body.aliasesData;

    console.log('Inserting ALIAS data:', JSON.stringify(aliasesData));
    try {
      const docRef = firestore.collection("ADMIN").doc("_aliases");
      await docRef.set(aliasesData);

      res.json({'result': 'OK'})
    } catch (err) {
      console.error(err);
      res.send({'result': err});
    }
  })
.post('/send-email', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.log('Got /send-email POST:', ip, JSON.stringify(req.body));
  
  if (!req.isAuthenticated) {
    console.warn('WARNING: attempting to SEND EMAIL but user not logged in.  Denied.');
    res.status(401).send({'result': 'Denied. User not logged in...'});
    return;
  }
  
  // get email list
  var emailTo = "";
  if (req.body.emailTo) {
    // convert emails array to csv
    emailTo = req.body.emailTo.toString();
  } else {
    res.json({'result': 'ERROR: No emailTo list defined'});
    return;
  }

  var mailOptions = {
    from: GOOGLE_MAIL_FROM_NAME,
    to: emailTo,
    subject: req.body.emailSubject,
    html: req.body.emailBody
  };

  // now send the email
  var emailResult = teamUtils.sendEmailToList(mailOptions, req.hostname);

  if (emailResult) {
    res.json({'result': 'OK'})
  } else {
    res.sendStatus(400);
  }
})
.get('/schedule/delete-draft-list-for-admins', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log("Deleting weekly teams GET", ip, req.get('X-Appengine-Cron'));
  if ((req.get('X-Appengine-Cron') === 'true') 
    && (ip.startsWith('0.1.0.2') || ip == '::1' || ip.endsWith('127.0.0.1'))) {
    // delete any previous gameweekpreview
    await firestore.collection("ADMIN").doc("GameWeekPreview").delete();
    console.log("DELETED", await firestore.collection("ADMIN").doc("GameWeekPreview").get())
    res.json({'result': 'DELETED'});
    return;
  } else {
    console.log("ERROR: Denied - internal endpoint only");
    res.status(403).end();
  }
})
.get('/schedule/generate-draft-list-for-admins', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log("Scheduling weekly teams GET", ip, req.get('X-Appengine-Cron'));
  if ((req.get('X-Appengine-Cron') === 'true') 
    && (ip.startsWith('0.1.0.2') || ip == '::1' || ip.endsWith('127.0.0.1'))) {

    var requestedDate = new Date();
    if (req.query.date) {
      requestedDate = new Date(req.query.date);
    }
    // check if bank holiday
    var nextMonday = getDateNextMonday(requestedDate);
    var bankHolidaysJson = await getBankHolidayJson();
    var dateString = nextMonday.toLocaleDateString('en-GB', localeDateOptions);
    var isBankHoliday = teamUtils.checkIfBankHoliday(bankHolidaysJson, nextMonday);
    if (isBankHoliday) {
      res.json({'result': 'Skipping - bank holiday'});
      return;
    }

    // allow cron to be disabled by setting app preferences
    var preferencesDoc = await firestore.collection("ADMIN").doc("_preferences").get();
    var preferences = preferencesDoc.data();
    if (!preferences) { preferences = {}; }
    if (!preferences.enableCronEmail) {
      console.log("SKIPPING SCHEDULED EMAIL - DISABLED IN PREFERENCES");
      res.json({'result': 'IGNORING - DISABLED IN PREFERENCES'});
      return;
    }

    // calculate next game teams and save
    var playersGamesPlayedRatio = await calculateNextGameTeams(nextMonday);
    var playersPreviewData = playersGamesPlayedRatio.generatedTeams;
    playersPreviewData.gameWeek = dateString;

    // save the list for future
    console.log("SAVING", playersGamesPlayedRatio.generatedTeams, nextMonday);
    playersPreviewData.lastUpdated = "Auto: " + new Date().toISOString();
    playersPreviewData.status = "Saved";
    await firestore.collection("ADMIN").doc("GameWeekPreview").set(playersPreviewData);

    // now generate the email text and send it
    var emailPrefix = "Auto generated teams."
    sendTeamsPreviewEmail(playersPreviewData, emailPrefix);
    res.json({'result': 'OK'});
  } else {
    console.log("ERROR: Denied - internal endpoint only");``
    res.status(403).end();
  }
})
.get('/schedule/send-weekly-teams', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log("Scheduling weekly teams GET", ip, req.get('X-Appengine-Cron'));
  if ((req.get('X-Appengine-Cron') === 'true') 
    && (ip.startsWith('0.1.0.2') || ip == '::1' || ip.endsWith('127.0.0.1'))) {
    // check if bank holiday
    var nextMonday = getDateNextMonday(new Date());
    var bankHolidaysJson = await getBankHolidayJson();
    var isBankHoliday = teamUtils.checkIfBankHoliday(bankHolidaysJson, nextMonday);
    if (isBankHoliday) {
      res.json({'result': 'Skipping - bank holiday'});
      return;
    }

    // allow cron to be disabled by setting app preferences
    var preferencesDoc = await firestore.collection("ADMIN").doc("_preferences").get();
    var preferences = preferencesDoc.data();
    if (!preferences) { preferences = {}; }
    if (!preferences.enableCronEmail) {
      console.log("SKIPPING SCHEDULED EMAIL - DISABLED IN PREFERENCES");
      res.json({'result': 'IGNORING - DISABLED IN PREFERENCES'});
      return;
    }

    // read the teams from the playersPreviewData
    var playersPreviewData = await getGameWeekPreviewTeams();

    // check if preview of teams has already been generated
    var previewDate = new Date(playersPreviewData.gameWeek);
    if (!teamUtils.datesAreOnSameDay(previewDate, nextMonday)) {
      console.error("ERROR - No ADMIN-GameWeekPreview data found (should have been generated by Thursday cron)", playersPreviewData);
      var playersGamesPlayedRatio = await calculateNextGameTeams(nextMonday);
      playersPreviewData = playersGamesPlayedRatio.generatedTeams;
    }

    var totalPlayers = playersPreviewData.redPlayers.length + playersPreviewData.bluePlayers.length;
    if (totalPlayers < 6) {
      // not enough players so send email to admin ONLY
      teamUtils.sendAdminEvent(EMAIL_TYPE_TEAMS_ADMIN, "[NOT ENOUGH PLAYERS] " + totalPlayers + EMAIL_TITLE_POSTFIX, playersPreviewData.redPlayers + "\n" + playersPreviewData.bluePlayers);
      res.json({'result': 'OK'});
      return;
    }

    // get the list of people on the email list
    var playerAliasMaps = await getDefinedPlayerAliasMaps();
    var emailTo = Object.values(playerAliasMaps.activeEmailList);
    // now generate the email text and send it
    var gameNextMondayDate = getDateNextMonday();
    var emailDetails = teamUtils.generateTeamsEmailText(playersPreviewData, gameNextMondayDate);
    var mailOptions = {
      from: GOOGLE_MAIL_FROM_NAME,
      to: emailTo,
      subject: emailDetails.emailSubject,
      text: emailDetails.emailBody
    };
    console.log(mailOptions);
    var emailResult = teamUtils.sendEmailToList(mailOptions, req.hostname);

    // finally delete the old gameweek preview - email has been sent
    //await firestore.collection("ADMIN").doc("GameWeekPreview").delete();

    res.json({'result': 'OK'});
  } else {
    console.log("ERROR: Denied - internal endpoint only");
    res.status(403).end();
  }
})
.post('/services/update-game-week-preview', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT UPDATE GAME WEEK PREVIEW POST FROM EMAIL:', ip, req.body);
  try {
    await firestore.collection("ADMIN").doc("GameWeekPreview").set(req.body, { merge: true });
    res.json({'result': 'OK'})
  } catch (err) {
    console.error(err);
    res.sendStatus(400);
  }
})
.get('/admin-team-preview', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT ADMIN TEAM-PREVIEW GET FROM:', ip, req.date);
  try {
    var requestedDate = new Date();
    if (req.query.date) {
      requestedDate = new Date(req.query.date);
    }
    var dateRange = 12; // default to 12 months
    if (req.query.dateRange && isNaN(req.query.dateRange)) {
      dateRange = Number(req.query.dateRange);
    }
    var nextMondayRequestedDate = getDateNextMonday(requestedDate);
    var pageData = {};

    // get preview teams (if saved)
    var playersPreviewData = await getGameWeekPreviewTeams();
    // check if preview of teams has already been generated, and is on the same day
    if (!teamUtils.datesAreOnSameDay(new Date(playersPreviewData.gameWeek), nextMondayRequestedDate)) {
      // no saved teams found for day requested, calculate next game teams
      var playersGamesPlayedRatio = await calculateNextGameTeams(nextMondayRequestedDate);
      var playersPreviewData = playersGamesPlayedRatio.generatedTeams;
      playersPreviewData.gameWeek = nextMondayRequestedDate.toISOString().split('T')[0];
      playersPreviewData.status = "Generated";
    }
    var pageData = { playersPreviewData: playersPreviewData, "environment": environment };

    // get all ratio data for comparison
    var allAttendanceData = await queryDatabaseAndCalcGamesPlayedRatio(nextMondayRequestedDate, dateRange);
    pageData.allAttendanceData = allAttendanceData;

    // build player list
    var rowdata = await queryDatabaseAndBuildPlayerList(nextMondayRequestedDate);
    pageData.players = rowdata;
    
    res.render('pages/admin-team-preview', { pageData: JSON.stringify(pageData)} );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.get('/admin', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.log('Got /admin GET:', ip, JSON.stringify(req.body));
  try {
    var pageData = { "environment": environment };

    if (req.isAuthenticated()) {
      console.log("User is logged in: ", JSON.stringify(req.user));
      pageData.user = req.user;
    } else {
      res.redirect(302, "/login?redirect=/admin");
      return;
    }

    // check user logged in roles
    pageData.user.roles = await getUserRoles(pageData.user);

    res.render('pages/admin', { pageData: JSON.stringify(pageData)} );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.get('/admin-preferences', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.log('Got /admin-preferences GET:', ip, JSON.stringify(req.body));
  try {
    var pageData = { "environment": environment };

    if (req.isAuthenticated()) {
      console.log("User is logged in: ", JSON.stringify(req.user));
      pageData.user = req.user;
    } else {
      res.redirect(302, "/login?redirect=/admin");
      return;
    }

    // lookup preferences from database
    var preferencesDoc = await firestore.collection("ADMIN").doc("_preferences").get();
    var preferences = preferencesDoc.data();
    if (!preferences) { preferences = {}; }
    pageData.preferences = preferences;

    res.render('pages/admin-preferences', { pageData: JSON.stringify(pageData)} );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})

.get('/admin-database', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.log('Got /admin-database GET:', ip, JSON.stringify(req.body));
  try {
    var pageData = { "environment": environment };

    if (req.isAuthenticated()) {
      console.log("User is logged in: ", JSON.stringify(req.user));
      pageData.user = req.user;
    } else {
      res.redirect(302, "/login?redirect=/admin");
      return;
    }

    pageData.database = await getAllDataFromDB();
    res.render('pages/admin-database', { pageData: JSON.stringify(pageData)} );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.post('/services/get-database-doc', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('POST /services/get-database-doc', ip, req.body);

  var collectionId = req.body.collectionId;
  var documentId = req.body.documentId;

  const docRef = firestore.collection(collectionId).doc(documentId);
  var existingDoc = await docRef.get();
  if (existingDoc && existingDoc.data()) {
    res.json({'result': existingDoc.data()});
  } else {
    res.sendStatus(404);
  }
})
.post('/services/update-database-doc', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('POST /services/update-database-doc', ip, req.body);

  var collectionId = req.body.collectionId;
  var documentId = req.body.documentId;
  var documentData = req.body.documentData;

  try {
    const docRef = firestore.collection(collectionId).doc(documentId);
    var existingDoc = await docRef.get();
    if (existingDoc && existingDoc.data()) {
      await docRef.set(documentData);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.post('/services/delete-database-doc', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('POST /services/delete-database-doc', ip, req.body);

  var collectionId = req.body.collectionId;
  var documentId = req.body.documentId;

  const docRef = firestore.collection(collectionId).doc(documentId);
  try {
    docRef.delete();
    res.json({'result': {} });
  } catch (err) {
    console.error(err);
    res.sendStatus(404);
  }
})
.post('/services/rename-database-doc', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('POST /services/delete-database-doc', ip, req.body);

  var collectionId = req.body.collectionId;
  var documentId = req.body.documentId;
  var newDocumentName = req.body.newDocumentName;

  try {
    const existingDocRef = firestore.collection(collectionId).doc(documentId);
    var existingDoc = await existingDocRef.get();
    if (existingDoc && existingDoc.exists) {
      var data = existingDoc.data();
      // saves the data to new name
      await firestore.collection(collectionId).doc(newDocumentName).set(data);
      // deletes the old document
      await firestore.collection(collectionId).doc(documentId).delete();
    }
    const newDocRef = firestore.collection(collectionId).doc(newDocumentName);
    var newDoc = await newDocRef.get();
    res.json({'result': newDoc.data()});
  } catch (err) {
    console.error(err);
    res.sendStatus(404);
  }
})
.listen(PORT, () => console.log(`Listening on ${ PORT }`))

// catch any unexpected exception and try to send an email alert before exiting
process.on('uncaughtException', function(err) {
  teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, "SERVER ERROR: Caught catastrophic exception. Check server logs", err);
  console.log('ERROR: Caught catastrophic exception: ' + err.message);
  //console.error((new Date).toUTCString() + ' uncaughtException:', err.message)
  console.error(err.stack)

  // Intentionally cause an exception by calling undefined function, but don't catch it.
  forceQuit();
  console.log('This will not run.');
});

function getDateNextMonday(fromDate = new Date()) {
  // Get the date next Monday
  nextMonday = fromDate;
  if ((nextMonday.getDay() == 1) && (nextMonday.getHours() >= 19)) {
    // date is a Monday after kick-off time (6-7pm), so jump forward a day to force the next week
    nextMonday.setDate(nextMonday.getDate() + 1);
    console.log('Currently a Monday after kick-off so adding a day to:' + nextMonday.toISOString());
  }
  nextMonday.setDate(nextMonday.getDate() + (1 + 7 - nextMonday.getDay()) % 7);
  console.log('Next Monday:' + nextMonday.toISOString());
  return nextMonday;
}

// download the url requested and return the json respose
async function downloadPage(url) {
    return fetch(url)
        .then((response)=>response.json())
        .then((responseJson)=>{return responseJson});
}

// calculate no of months between two dates
function monthDiff(dateFrom, dateTo) {
  return dateTo.getMonth() - dateFrom.getMonth() + 
    (12 * (dateTo.getFullYear() - dateFrom.getFullYear()))
}

async function queryDatabaseAndCalcGamesPlayedRatio(maxDate, previousNoOfMonths = 12) {
  // game scores and win/lose/draw only available from 2023-01-01 (game played available from 2019-08-01)
  if (!maxDate) { maxDate = new Date(); }
  var requestedDate = new Date(maxDate);
  noOfMonths = monthDiff(new Date("2023-01-01"), requestedDate);
  noOfMonths = Math.min(noOfMonths, previousNoOfMonths);

  var allAttendanceData = {};
  for (var i = 0; i <= noOfMonths; i ++) {
    var thisDate = new Date(requestedDate);
    thisDate.setMonth(requestedDate.getMonth() - i);
    var gameYear = thisDate.getFullYear();
    var gameMonth = thisDate.toISOString().split('-')[1];
    var gamesCollectionId = "games_" + gameYear + "-" + gameMonth + "-01";
    //console.log('GETTING ATTENDANCE data:', gamesCollectionId);
    const docRef = firestore.collection(gamesCollectionId).doc("_attendance");
    var existingDoc = await docRef.get();
    if (existingDoc.data()) {
      var attendanceData = existingDoc.data();
      allAttendanceData[gamesCollectionId] = attendanceData;
    }
  }
  return allAttendanceData;
}

async function queryDatabaseAndBuildOutstandingPayments(reqDate, noOfMonths = 3) {
    var requestedDate = new Date();
    if (reqDate) {
      requestedDate = new Date(reqDate);
    } else {
      // if date not specified just default to beginning of this month
      requestedDate.setDate(1);
    }
    
    var openFinancialYear = 0; 
    var preferencesDoc = await firestore.collection("ADMIN").doc("_preferences").get();
    var preferences = preferencesDoc.data();
    if (preferences && preferences.openFinancialYear) {
      openFinancialYear = preferences.openFinancialYear;
    }
    //console.log("openFinancialYear", openFinancialYear)

    const paymentsCollection = firestore.collection("OPEN_LEDGER");
    const allPaymentsDocs = await paymentsCollection.get();
    var playersUnPaid = {};
    allPaymentsDocs.forEach(doc => {
      var playerName = doc.id;
      var playerPaymentData = doc.data();
      var totalCharges = 0;
      var totalPayments = 0;
      var charges = [];
      var payments = [];
      Object.keys(playerPaymentData).sort().forEach(function(transaction) {
      //console.log('GOT transaction:', playerName, transaction, playerPaymentData[transaction]);
        if (transaction.startsWith("charge_")) {
          if (playerPaymentData[transaction].financialYear == openFinancialYear) {
            // TODO: Consider whether noOfMonths is still needed and if a filter is needed
            totalCharges += playerPaymentData[transaction].amount;
            charges.push(transaction.replace('charge_', ''));
          }
        }
        if (transaction.startsWith("payment_")) {
          if (playerPaymentData[transaction].financialYear == openFinancialYear) {
            totalPayments += playerPaymentData[transaction].amount;
            payments.push(transaction);
          }
        }
      })
      //console.log('GOT player payment data:', playerName, totalCharges, totalPayments);
      var outstandingBalance = totalCharges + totalPayments;
      if (outstandingBalance < 0) {
        totalAmountOwed = (totalCharges * -1);
        totalNoGames = (totalAmountOwed / COST_PER_GAME) - (totalPayments / COST_PER_GAME);
        totalOutstandingBalance = (outstandingBalance * -1);
        playersUnPaid[playerName] = { "numberOfGames": totalNoGames, "amountOwed": (outstandingBalance * -1), 
          "amountPaid": 0, "outstandingBalance": totalOutstandingBalance, "charges": charges, "payments": payments};
      }
    });

    return playersUnPaid;
}

async function queryDatabaseAndBuildPlayerList(reqDate, filterType = PLAYER_UNIQUE_FILTER) {
    // Get the date next Monday
    nextMonday = new Date();
    if ((nextMonday.getDay() == 1) && (nextMonday.getHours() >= 19)) {
      // date is a Monday after kick-off time (6-7pm), so jump forward a day to force the next week
      nextMonday.setDate(nextMonday.getDate() + 1);
      console.log('Currently a Monday after kick-off so adding a day to:' + nextMonday.toISOString());
    }
    nextMonday.setDate(nextMonday.getDate() + (1 + 7 - nextMonday.getDay()) % 7);
    console.log('Next Monday:' + nextMonday.toISOString());

    var requestedDate = new Date();
    var requestedDate = nextMonday;
    if (reqDate) {
      requestedDate = new Date(reqDate);
    }
    // default to beginning of this month
    requestedDate.setDate(1);
    
    var requestedDateMonth = requestedDate.toISOString().split('T')[0]
    //console.log("requestedDateMonth=" + requestedDateMonth)

    // read the list of players and aliases
    var playerAliasMaps = await getDefinedPlayerAliasMaps();
    //console.log('playerAliasMaps=' + JSON.stringify(playerAliasMaps));

    // Query database and get all players for games matching this month
    const dbresult = await firestore.collection("games_" + requestedDateMonth).orderBy('timestamp', 'asc').get();
    //console.log('dbresult=' + JSON.stringify(dbresult));
    var rowdata = {};
    if (dbresult.size > 0) {
      // We have data! now build the player list and set it as the players for the front-end
      rowdata = {}
      rowdata.status = "FROM_DATABASE"
      rowdata.gameid = requestedDateMonth
      rowdata.playerAliasMaps = playerAliasMaps;
      if (filterType == PLAYER_LOG_FILTER) {
        rowdata.players = buildPlayerLogList(dbresult);
      } else {
        // build players from the whole log list
        rowdata.players = buildPlayerUniqueList(dbresult);
      }
      rowdata.nextMonday = nextMonday
    } else {
      // create a blank entry to render the poll page
      rowdata = { "status": "NO_DATABASE_ENTRY", "gameid": requestedDateMonth, "players":{},
        "nextMonday": nextMonday, "playerAliasMaps": playerAliasMaps, "attendance": {}, "paydetails": {}}
    }

    // Query database and get all attendance lists for this month
    var attendedData = {};
    var paymentData = {};
    var scoresData = {};
    var cancelledData = {};
    dbresult.forEach((doc) => {
      if (doc.data().saveType == "ATTENDANCE") {
        // assume no more than 4 weeks in a month
        for (var weekNumber = 0; weekNumber < 5; weekNumber ++) {
          attendedData[weekNumber] = doc.data()[weekNumber];
          //console.log('Added Attendance for week: ' + weekNumber + " " + JSON.stringify(attendedData[weekNumber]));

          //extract the scores data out of the attended list
          if (attendedData[weekNumber] && attendedData[weekNumber].status) {
            if (attendedData[weekNumber].status.status == "CANCELLED") {
              cancelledData[weekNumber] = attendedData[weekNumber].status;
            } else {
              scoresData[weekNumber] = attendedData[weekNumber].scores;
            }
            delete attendedData[weekNumber].scores;
          }
        }
        //paymentData = doc.data().paydetails;
        scoresData.status = (doc.data().status) ? doc.data().status : "open";
        //
      }
    });
    //console.log('LOADED from DB attendedData by week: ', JSON.stringify(attendedData));

    // transform from {weekNumber: {player1, player2}} to {player: {weekNumber, weekNumber}}
    var attendedDataByPlayer = {};
    Object.keys(attendedData).sort().forEach(function(weekNumber) {
      if (attendedData[weekNumber] && attendedData[weekNumber].players) {
        Object.keys(attendedData[weekNumber].players).sort().forEach(function(player) {
          if (!attendedDataByPlayer[player]) {
            attendedDataByPlayer[player] = {};
          }
          var playerSelection = attendedData[weekNumber].players[player];
          attendedDataByPlayer[player][weekNumber] = playerSelection;
        });
      }
    });
    //console.log('TRANSFORMED attendedData by player: ' + JSON.stringify(attendedDataByPlayer));

    rowdata.attendance = attendedDataByPlayer;
    rowdata.scores = scoresData;
    rowdata.cancelled = cancelledData;
    //  rowdata.paydetails = paymentData;

    //console.log('rowdata=' + JSON.stringify(rowdata));
    return rowdata;
}


function buildPlayerLogList(dbresult) {
  //loop through all rows and merge the player data into one map
  var playerdata = {};
  dbresult.forEach((doc) => {
    if (!doc.id.startsWith("_")) {
      //console.log(doc.id, '=>', doc.data());
      playerName = new Date(doc.data().timestamp.seconds*1000).toISOString().replace(/T|\..*Z/g, ' ') + " " + doc.data().playerName + "\\t" + doc.data().saveType;
      playerData = doc.data().playerAvailability;
      if (doc.data().originalPlayerName) {
        //console.log("FOUND originalPlayerName:" + originalPlayerName);
        playerData["originalName"] = doc.data().originalPlayerName;
      }
      playerdata[playerName] = playerData;
    }
  });
  return playerdata;
}


function buildPlayerUniqueList(dbresult) {
  //loop through all rows and merge the player data into one map
  var playerdata = {};
  dbresult.forEach((doc) => {
    //console.log(doc.id, '=>', doc.data());
    if (!doc.id.startsWith("_")) {
      playerName = doc.data().playerName;
      playerAvailability = doc.data().playerAvailability;
      saveType = doc.data().saveType;
      originalPlayerName = doc.data().originalPlayerName;
      switch (saveType) {
        case "NEW":
          // console.log('Adding Player=' + playerName);
          playerdata[playerName] = playerAvailability
          break;
        case "DELETE":
          // console.log('Removing Player=' + playerName);
          delete playerdata[playerName]
          break;
        case "RENAME":
          // console.log('Renaming Player=' + originalPlayerName + " to " + playerName);
          delete playerdata[originalPlayerName]
          playerdata[playerName] = playerAvailability
          break;
        case "EDIT":
          playerdata[playerName] = playerAvailability
          break;
        default:
          console.log('WARN - Skipping player:' + playerName + ' Unknown saveType:' + saveType);
      }
    }
  });
  //console.log('AllPlayers=', JSON.stringify(playerdata));
  return playerdata;
}

// check for unique player name
async function getDefinedPlayerAliasMaps() {
  var aliasesDoc = await firestore.collection("ADMIN").doc("_aliases").get();
  var aliasesData = aliasesDoc.data();
  if (!aliasesData) {
    aliasesData = {};
  }

  var playerToAliasMap = {};
  var aliasToPlayerMap = {};
  Object.keys(aliasesData).sort().forEach(function(key) {
    var officialName = key.trim();
    // create the player to alias map
    playerToAliasMap[officialName] = aliasesData[key].aliases;

    // create a reverse lookup map from alias to official name
    var aliasesList = aliasesData[key].aliases;
    aliasToPlayerMap[officialName.toUpperCase()] = officialName;
    for (var i = 0; i < aliasesList.length; i ++) {
      var aliasName = aliasesList[i].trim();
      if (aliasName != "") {
        aliasToPlayerMap[aliasName.toUpperCase()] = officialName;
      }
    }
  });

  var playerAliasMaps = { playerToAliasMap: playerToAliasMap, aliasToPlayerMap: aliasToPlayerMap };
  return playerAliasMaps;
}

// check for unique player name
async function getDefinedPlayerEmailMaps() {
  var aliasesDoc = await firestore.collection("ADMIN").doc("_aliases").get();
  var aliasesData = aliasesDoc.data();
  if (!aliasesData) {
    aliasesData = {};
  }

  var playerToEmailMap = {};
  var playerToTokenMap = {};
  var activeEmailList = {};
  Object.keys(aliasesData).sort().forEach(function(key) {
    var officialName = key.trim();
    
    // create the player to email map
    playerToEmailMap[officialName] = aliasesData[key].email;
    // create the player to token map
    playerToTokenMap[officialName] = aliasesData[key].token;

    // create the active player email list
    var playerEmail = aliasesData[key].email;
    var playerActive = (aliasesData[key].subscriptionStatus == 2) ? true : false;
    if (playerActive && playerEmail) {
      activeEmailList[officialName] = officialName + " <" + playerEmail + ">";
    }
  });

  var playerEmailMaps = { playerToEmailMap: playerToEmailMap, playerToTokenMap: playerToTokenMap, activeEmailList: activeEmailList };
  return playerEmailMaps;
}

// clear the stats and database cache - need recalculating next time it reloads
function invalidateDataCaches() {
  attendanceMapByYearCache = {};
  rawDatabaseCache = {};
}

// helper function to convert availabilityMap to human readable string
// From: availabilityMap = {"0":true, "1":false, "2":true, "3":true };
// To: '2023-10-08: YES\n2023-10-16: NO...'
function convertAvailibilityToDates(gameMonth, gameYear, availabilityMap) {
  var mondaysDates = teamUtils.mondaysInMonth(Number(gameMonth), Number(gameYear));  //=> [ 7,14,21,28 ]

  var returnString = "";
  Object.keys(availabilityMap).forEach(function(weekNumber) {
    var mondaysDate = new Date(gameYear + "-" + gameMonth + "-" + mondaysDates[weekNumber]);
    var dateString = mondaysDate.toISOString()
    var canPlay = "YES";
    (availabilityMap[weekNumber]) ? canPlay = "YES" : canPlay = "NO";
    returnString += dateString.substring(0, dateString.indexOf("T")) + ": " + canPlay + "\n";
  });
  return returnString;
}

// save players that played for each team
async function saveTeamsAttendance(gameDate, redGoalScorers, blueGoalScorers, scores = undefined) {
 try {
   var gameDateString = gameDate.toISOString().split('T')[0]; //2023-11-27
   var gameMonth = gameDateString.slice(0, -3); //2023-11
   var gamesCollectionId = "games_" + gameMonth + "-01";

   var redTeamPlayers = Object.keys(redGoalScorers)
   var blueTeamPlayers = Object.keys(blueGoalScorers)

   // find the index for the week
   var mondaysDates = teamUtils.mondaysInMonth(gameDate.getMonth()+1, gameDate.getFullYear());  //=> [ 7,14,21,28 ]
   var weekNumber = -1;
   for (var i = 0; i < mondaysDates.length; i ++) {
     if (mondaysDates[i] == gameDate.getDate()) {
       weekNumber = i;
       console.log("Found date:" + gameDate + " with index:" + weekNumber);
       break;
     }
   }

   // read the list of players and aliases
   var playerAliasMaps = await getDefinedPlayerAliasMaps();
   var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];

   var timestamp = new Date();
   var saveType = "ATTENDANCE"
   var ip = "UNKNOWN";
   var attendanceDetails = { "month": gameMonth, "timestamp": timestamp, "saveType": saveType, "source_ip": "email from " + ip };

   var allPlayers = {};
   for(var i = 0; i < redTeamPlayers.length; i++) {
     var playerName = redTeamPlayers[i].replace(/\d+/g, '').replace(/\*/g, '').trim();
     // check if there is an official name
     var officialPlayerName = teamUtils.getOfficialNameFromAlias(playerName, aliasToPlayerMap);
     playerName = (officialPlayerName) ? officialPlayerName : playerName;
     allPlayers[playerName] = 1;
   }
   for(var i = 0; i < blueTeamPlayers.length; i++) {
     var playerName = blueTeamPlayers[i].replace(/\d+/g, '').replace(/\*/g, '').trim();
     // check if there is an official name
     var officialPlayerName = teamUtils.getOfficialNameFromAlias(playerName, aliasToPlayerMap);
     playerName = (officialPlayerName) ? officialPlayerName : playerName;
     allPlayers[playerName] = 2;
   }
   attendanceDetails[weekNumber] = {"players": allPlayers};
   if (scores) {
     attendanceDetails[weekNumber].scores = scores;
   }
   attendanceDetails[weekNumber].scores.team1scorers = redGoalScorers;
   attendanceDetails[weekNumber].scores.team2scorers = blueGoalScorers;

   // set the status
   attendanceDetails[weekNumber].status = {"status": "PROVISIONAL_FROM_EMAIL", "date": gameDateString}

   console.log('Inserting DB data:', gamesCollectionId, JSON.stringify(attendanceDetails));
   const docRef = firestore.collection(gamesCollectionId).doc("_attendance");
   var existingDoc = await docRef.get();
   if (!existingDoc.data()) {
     console.log('CREATING:', JSON.stringify(attendanceDetails));
     await docRef.set(attendanceDetails);
   } else {
     // copy the existing doc to preserve a history
     var existingDocData = existingDoc.data();
     existingDocData.saveType = "ATTENDANCE_BACKUP"
     if (true || !existingDocData[weekNumber] || !existingDocData[weekNumber].scores) {
       console.log('UPDATING:', JSON.stringify(attendanceDetails));
       //const backupDocRef = firestore.collection(gamesCollectionId).doc("_attendance_" + existingDocData.timestamp);
       //backupDocRef.set(existingDocData)
       // now update with the new data
       await docRef.update(attendanceDetails);
     } else {
       console.log('STORING IN DEAD LETTER:', JSON.stringify(attendanceDetails));
       // scores already in so needs manual intervention as need to be careful
       // store in dead letter queue
       var emailSubjectGameDate = "DUPLICATE";
       const docRef = firestore.collection("INBOUND_EMAILS").doc(emailSubjectGameDate + "_" + gameDate);
       await docRef.set(attendanceDetails);
     }
   }
   invalidateDataCaches();
   return true;
 } catch (err) {
   console.log(err);
   return false;
 } 
}

/*
2025-10-12 16:12:27 default[20251012t163544]  "POST /_ah/mail/teams@tensile-spirit-360708.appspotmail.com HTTP/1.1" 200
2025-10-12 16:12:27 default[20251012t163544]  Got /_ah/mail/teams@... with Content-Type: message/rfc822
2025-10-12 16:12:28 default[20251012t163544]  First Monday of month: 2025-10-06T00:00:00.000Z
2025-10-12 16:12:28 default[20251012t163544]  Found date:Mon Oct 13 2025 18:00:00 GMT+0000 (Coordinated Universal Time) with index:1
2025-10-12 16:12:28 default[20251012t163544]  SUCCESS: Saved teams from email: 13 Oct
2025-10-12 16:12:28 default[20251012t163544]  Inserting DB data: games_2025-10-01 {"1":{"Jack W":1,"Phil R":1,"Vincent H":1,"Sam B":1,"Jon G":1,"Kyle C":1,"Tom B":1,"Phil G":1,"Rich M":1,"Will J":1,"Jord B":1,"Josh M":1,"scores":{"team1scorers":{"Jack W":0,"Phil R":0,"Vincent H":0,"Sam B":0,"Jon G":0,"Kyle C":0,"Tom B":0,"Phil G":0,"Rich M":0,"Will J":0,"Jord B":0,"Josh M":0},"team2scorers":{}}},"month":"2025-10","timestamp":"2025-10-12T16:12:28.718Z","saveType":"ATTENDANCE","source_ip":"email from UNKNOWN"}
2025-10-12 16:12:28 default[20251012t163544]  UPDATING: {"1":{"Jack W":1,"Phil R":1,"Vincent H":1,"Sam B":1,"Jon G":1,"Kyle C":1,"Tom B":1,"Phil G":1,"Rich M":1,"Will J":1,"Jord B":1,"Josh M":1,"scores":{"team1scorers":{"Jack W":0,"Phil R":0,"Vincent H":0,"Sam B":0,"Jon G":0,"Kyle C":0,"Tom B":0,"Phil G":0,"Rich M":0,"Will J":0,"Jord B":0,"Josh M":0},"team2scorers":{}}},"month":"2025-10","timestamp":"2025-10-12T16:12:28.718Z","saveType":"ATTENDANCE","source_ip":"email from UNKNOWN"}
*/

// parse a list (array) of text containing the teams and extracts the player names
function parsePlayerTeamNames(playerArray, startIndex, aliasToPlayerMap) {
  var nameGoalMap = {};
  var blankLines = 0;
  var currentLineCount = 0;
  // parse max 100 rows (some may be blank)
  for (j=0; j<100; j++) {
    var cleanName = playerArray[startIndex+j+1].replace(/^>+/g, '').replace(/<br>/g, '').trim().replace(/^\d/, '')
        .replace(/^\./g, '').replace(/^/g, '').replace(/\*+/i, '').trim();
    if (cleanName.toUpperCase() == "") {
      // count the number of blank lines
      blankLines++;
    }
    if (cleanName.toUpperCase().startsWith("BLUE") 
      || cleanName.toUpperCase().startsWith("RED") 
      || cleanName.toUpperCase().startsWith("STAND")
      || blankLines > 3) {
      // found the header/blank so exit from the loop
      //console.log("Exiting loop here:", j, cleanName);
      break;
    } else if (cleanName) {
      var cleanNameArray = cleanName.split(" ");
      console.log("Adding player to team", j, cleanName,cleanNameArray);

      var noOfGoals = 0;
      //var noOfGoals = cleanNameArray[cleanNameArray.length];
      //if (Number.isInteger(noOfGoals)) {
      var hasGoals = cleanName.match(/(\d+)/);
      if (hasGoals && hasGoals.length > 0) {
        noOfGoals = Number(hasGoals[0]);
        cleanName = cleanName.replace(noOfGoals, '').trim();
        console.log("-----CLEANED Adding player to team", j, cleanName, noOfGoals, hasGoals);
      }
      var officialPlayerName = teamUtils.getOfficialNameFromAlias(cleanName, aliasToPlayerMap);
      if (officialPlayerName) {
        nameGoalMap[officialPlayerName] = noOfGoals;
        blankLines = 0;
      } else {
        console.error("ERROR. Skipping adding player to attendance list - error parsing player name:", cleanName);
      }
    }
  }
  return nameGoalMap;
}

// record a payment transaction
async function receivePaymentEmail(payeeName, amount, transactionId, transactionDate) {
  var dayString = "" + transactionDate.getDate();
  if (dayString.length == 1) {
    dayString = "0" + dayString;
  }
  var monthString = "" + (transactionDate.getMonth()+1);
  if (monthString.length == 1) {
    monthString = "0" + monthString;
  }

  var openFinancialYear = 0; 
  var preferencesDoc = await firestore.collection("ADMIN").doc("_preferences").get();
  var preferences = preferencesDoc.data();
  if (preferences && preferences.openFinancialYear) {
    openFinancialYear = preferences.openFinancialYear;
  }
  console.log("openFinancialYear", openFinancialYear)

  // read the list of players and aliases
  var playerAliasMaps = await getDefinedPlayerAliasMaps();
  var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];
  var officialPlayerName = teamUtils.getOfficialNameFromAlias(payeeName, aliasToPlayerMap);

  try {
    // read list of outstanding payments for the player
    const playerClosedLedgerDocRef = firestore.collection("CLOSED_LEDGER").doc(officialPlayerName);
    var thisDate = transactionDate.getFullYear() + "-" + monthString + "-" + dayString;
    var playerTransactionName = "payment_" + thisDate + "_" + transactionId;
    var playerClosedLedgerDoc = await playerClosedLedgerDocRef.get();
    if (playerClosedLedgerDoc.data() && playerClosedLedgerDoc.data()[playerTransactionName]) {
      console.warn("transaction already exists, skipping to avoid double counting...", playerTransactionName);
      //res.send({'result': 'Already exists: ' + playerTransactionName});
      return true;
    }
    var playerTransactionSavedata = {};
    playerTransactionSavedata[playerTransactionName] = { "amount": amount, "paypalTransactionId": transactionId, "financialYear": openFinancialYear };
    console.log('Adding PAYMENTS:', officialPlayerName, thisDate, JSON.stringify(playerTransactionSavedata));
    playerClosedLedgerDocRef.set(playerTransactionSavedata, { merge: true });

    ////////////////// TODO: Store payment in dead-letter queue if officialPlayerName not found (throws exception)

    // now mark off the games for that payment
    const playerOpenLedgerDocRef = firestore.collection("OPEN_LEDGER").doc(officialPlayerName);
    var playerLedgerDoc = await playerOpenLedgerDocRef.get();
    if (playerLedgerDoc.data()) {
      var playerLedgerData = playerLedgerDoc.data();
      var amountLeft = amount;
      if (Object.keys(playerLedgerData).length > 0) {
        Object.keys(playerLedgerData).sort().forEach( async function(transactionName) {
          if (transactionName.startsWith("charge_")) {
            var thisTransaction = playerLedgerData[transactionName];
            if (amountLeft >= (thisTransaction.amount * -1)) {
              console.log('Moving transaction from open to closed ledger:', officialPlayerName, amountLeft, thisTransaction.amount, JSON.stringify(thisTransaction));
              amountLeft += thisTransaction.amount;
              thisTransaction.paid = transactionId;
              // add it to the closed ledger
              var closedTransaction = {};
              closedTransaction[transactionName] = thisTransaction;
              playerClosedLedgerDocRef.set( closedTransaction, { merge: true });
              // remove this transaction from the open ledger
              delete playerLedgerData[transactionName];
            }
          }
        });
      }
      if (amountLeft != amount) {
        // some ledger transactions have changed so update
        if (Object.keys(playerLedgerData).length == 0) {
          playerOpenLedgerDocRef.delete();
        } else {
          playerOpenLedgerDocRef.set(playerLedgerData);
        }
      }

      ////////////////// TODO: Store amount left if >0

      console.log('Got playerLedgerData for:', officialPlayerName, JSON.stringify(playerLedgerData));
    }
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

// record a payment transaction
async function refundPayment(paypalTransactionId) {
  // loop through all players in CLOSED_LEDGER
  const closedLedgerCollection = firestore.collection("CLOSED_LEDGER");
  const allClosedLedgerDocs = await closedLedgerCollection.get();
  var closedLedgers = {};
  // loop through all players
  var foundTransaction = false;
  allClosedLedgerDocs.forEach(doc => {
    var key = doc.id;
    var data = doc.data();
    //console.log(doc.id);
    closedLedgers[key] = data;
    var updateDoc = false;
    // loop through all transactions
    for (var transaction in data) {
      if (transaction.startsWith("charge_") && data[transaction].paid == paypalTransactionId) {
        console.log("FOUND MATCHING CHARGE", paypalTransactionId, transaction);
        // remove the paid flag and move the charge to the open ledger
        delete data[transaction].paid;
        var openLedgerData = {};
        openLedgerData[transaction] = data[transaction];
        firestore.collection("OPEN_LEDGER").doc(key).set(openLedgerData, { merge: true });
        // delete the charge from closed ledger
        delete data[transaction];
        foundTransaction = true;
        updateDoc = true;
      }
      if (transaction.startsWith("payment_") && data[transaction].paypalTransactionId == paypalTransactionId) {
        console.log("FOUND MATCHING PAYMENT", paypalTransactionId, transaction);
        // delete the payment
        delete data[transaction];
        foundTransaction = true;
        updateDoc = true;
      }
    }
    if (updateDoc) {
      // store the updated data
      console.log("Updating CLOSED_LEDGER with removed transaction(s) for", doc.id);
      doc._ref.set(data);
    }
  })
  //console.log("FOUND?", paypalTransactionId, foundTransaction);
  return foundTransaction;
}

// string name/email, int subscriptionStatus
async function addRemoveEmailSubscription(details, hostname) {
  //console.log("LLL", details, hostname)
  var aliasesDoc = await firestore.collection("ADMIN").doc("_aliases").get();
  var aliasesData = aliasesDoc.data();

  var email = details.email;
  var name = details.name;
  var optIn = details.optIn;

  var mailinglistChanged = false;
  var sendConfirmationEmail = false;
  var foundExistingPlayer = false;
  var playerKey = "";
  Object.keys(aliasesData).sort().forEach(function(key) {
    console.log("key", aliasesData[key]);
    if (aliasesData[key].email.toUpperCase() == email.toUpperCase()) {
      foundExistingPlayer = true;
      playerKey = key;
      if (!teamUtils.checkNotProto(playerKey)) return false;
      if (optIn) {
        // add/edit to subscribe email
        if (aliasesData[key].subscriptionStatus == MAIL_SUBSCRIPTION_STATUS_SUBSCRIBED) {
          // already subscribed so do nothing
          console.log("ALREADY SUBSCRIBED:", key, email, aliasesData[key]);
          mailinglistChanged = false;
        } else if (aliasesData[key].subscriptionStatus == MAIL_SUBSCRIPTION_STATUS_CONFIRMING) {
          // resend email
          console.log("STILL CONFIRMING - resending confirmation email request:", key, email, aliasesData[key]);
          // SEND CONFIRMATION EMAIL NOW
          mailinglistChanged = false;
          sendConfirmationEmail = true;
        } else if (aliasesData[key].subscriptionStatus == MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED) {
          // add new email
          console.log("Resubscribing email to mailing list:", key, email, aliasesData[key]);
          // SEND CONFIRMATION EMAIL NOW
          aliasesData[key].subscriptionStatus = MAIL_SUBSCRIPTION_STATUS_CONFIRMING;
          mailinglistChanged = true;
          sendConfirmationEmail = true;
        }
      } else {
        // remove/unsubscribe email
        if (aliasesData[key].subscriptionStatus == MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED) {
          // already unsubscribed so do nothing
          console.log("ALREADY UNSUBSCRIBED:", key, email, aliasesData[key]);
          mailinglistChanged = false;
        } else {
          //MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED
          console.log("UNSUBCRIBING:", key, email, aliasesData[key]);
          aliasesData[key].subscriptionStatus = MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED;
          mailinglistChanged = true;
          sendConfirmationEmail = true;
        }
      }
    }
  });

  if (!foundExistingPlayer && optIn) {
    // no existing player
    // create alias key... the first name and first initial of surname
    var nameAliasKey = name.substring(0, name.trim().lastIndexOf(" ") + 2);
    if (!teamUtils.checkNotProto(nameAliasKey)) return false;
    if (!aliasesData[nameAliasKey]) {
      playerKey = nameAliasKey;
      mailinglistChanged = true;
      sendConfirmationEmail = true;
      // create a new player
      aliasesData[playerKey] = {"aliases": [ name ], "subscriptionStatus": MAIL_SUBSCRIPTION_STATUS_CONFIRMING, "email": email};
      console.log("Adding new email to mailing list:", name, email, aliasesData[nameAliasKey]);
    } else {
      console.error("ERROR - nameAliasKey already exists", name, email, aliasesData[nameAliasKey]);
      // TODO - need to handle this better
      return false;
    }
  }
  if (sendConfirmationEmail) {
    var urlPrefix = "";
    if (hostname == "localhost") {
      urlPrefix = "http://" + hostname + ":5000";
    } else {
      urlPrefix = "https://" + hostname;
    }
    var emailSubject = "";
    var emailText = "";
    if (optIn) {
      // now generate the email text and send it
      emailSubject = "Confirm your email address [Footie, Goodwin, 6pm Mondays]";
      emailText = "Welcome to Sheffield Monday Night footie mailing list!\n\n";
      emailText += "To subscribe please confirm it is you by clicking the confirm link...\n";
      let playerData = aliasesData[playerKey];
      playerData.date = details.date;
      var code = playerData.date.getTime();
      playerData.code = code;
      aliasesData[playerKey] = playerData;
      emailText += urlPrefix + "/mailing-list?code=" + code;
    } else {
      emailSubject = "You have been unsubscribed [Footie, Goodwin, 6pm Mondays]";
      emailText = "Sorry to see you go from Sheffield Monday Night footie.\n\n";
      emailText += "Feel free to re-subscribe anytime by signing up again here...\n";
      emailText += urlPrefix + "/mailing-list";
    }
    mailinglistChanged = true;

    var mailOptions = {
      from: GOOGLE_MAIL_FROM_NAME,
      to: email,
      subject: emailSubject,
      text: emailText
    };
    //console.log(mailOptions); 
    var emailResult = teamUtils.sendEmailToList(mailOptions, hostname);
  }
  if (mailinglistChanged) {
    console.log("UPDATED LIST SO SAVING", aliasesData[playerKey]);
    teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, "[Mailing List Change Event] " + email + EMAIL_TITLE_POSTFIX, email + "\n" + aliasesData[playerKey].subscriptionStatus);
    await firestore.collection("ADMIN").doc("_aliases").set(aliasesData);
  }
  return true;
}


async function calculateNextGameTeams(date = new Date()) {
    // choose the algorithm to us to select the teams
    var algorithmType = "algorithm6";
    var algorithmName = "ParityGPG";
    var nextMonday = getDateNextMonday(date);
    var gameYear = nextMonday.getFullYear();
    var gameMonth = nextMonday.toISOString().split('-')[1];
    var dateString = gameYear + "-" + gameMonth + "-01";

    console.log('Generating TEAMS data for date: ', dateString);
    //calc date - use the next Monday after the email date
    var rowdata = await queryDatabaseAndBuildPlayerList(dateString);
    var players = rowdata.players;

    // read the list of players and aliases
    var playerAliasMaps = await getDefinedPlayerAliasMaps();
    var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];

    //
    var mondaysDates = teamUtils.mondaysInMonth(nextMonday.getMonth()+1, nextMonday.getFullYear());  //=> [ 7,14,21,28 ]
    var nextMondayOptionIndex = teamUtils.getNextMondayIndex(mondaysDates, nextMonday);
    //console.log("mondaysDates:", mondaysDates, nextMondayOptionIndex);

    // read the teams from the playersPreviewData
    var playersPreviewData = await getGameWeekPreviewTeams();

    // change the algorithm for all players and regenerate teams
    var algorithmRange = 12;
    var allAttendanceData = await queryDatabaseAndCalcGamesPlayedRatio(date);
    var playersGamesPlayedRatio = teamUtils.changeAlgorithmForPlayers(algorithmType, algorithmName, players, playersPreviewData, 
      allAttendanceData, aliasToPlayerMap, nextMondayOptionIndex, algorithmRange);
    return playersGamesPlayedRatio;
}

// get all data from DB
async function getAllDataFromDB() {
  // get a list of all collections
  var allCollections = [];
  await firestore.listCollections().then(snapshot=>{
    snapshot.forEach(snaps => {
      allCollections.push(snaps["_queryOptions"].collectionId);
    })
  })
  .catch(error => console.error(error));
  // loop through each collection and get the docs
  var allCollectionDocs = {};
  //allCollections.length
  for (var i=0; i<allCollections.length; i++) {
    var collectionId = allCollections[i];
    //console.log("Collecting docs from:", collectionId);
    const collection = await firestore.collection(collectionId)
    var allDocs = {};
    await collection.get().then((querySnapshot) => {
      const tempDoc = querySnapshot.docs.map((doc) => {
        var obj = { "id": doc.id, "data": doc.data() }
        return obj;
      })
      allDocs[tempDoc.id] = tempDoc;
      //console.log("ALL DOCS", tempDoc);
      allCollectionDocs[collectionId] = tempDoc;
    })
  }
  return allCollectionDocs;
}

async function getGameWeekPreviewTeams() {
  // read the teams from the playersPreviewData
  var playersPreviewDoc = await firestore.collection("ADMIN").doc("GameWeekPreview").get();
  var playersPreviewData = playersPreviewDoc.data();
  console.log("SAVED PREVIEW", playersPreviewData);
  if (!playersPreviewData) {
    // not yet available so create empty object
    playersPreviewData = {};
    playersPreviewData.redPlayers = [];
    playersPreviewData.bluePlayers = [];
    playersPreviewData.standbyPlayers = [];
    playersPreviewData.stats = {};
    playersPreviewData.status = "New";
  }
  return playersPreviewData;
}

// get the array index that matches the game-week for a given date
// can be used in mondaysInMonth[index] or playerAvailability[index]
function getGameWeekMonthIndex(gameDate) {
   // find the index for the week
   var mondaysDates = teamUtils.mondaysInMonth(gameDate.getMonth()+1, gameDate.getFullYear());  //=> [ 7,14,21,28 ]
   var weekNumber = -1;
   for (var i = 0; i < mondaysDates.length; i ++) {
     if (mondaysDates[i] == gameDate.getDate()) {
       weekNumber = i;
       console.log("Found date:" + gameDate + " with index:" + weekNumber);
       break;
     }
   }
   return weekNumber;
}

// generate email text and send it
function sendTeamsPreviewEmail(playersPreviewData, emailPrefix) {
  if (!((playersPreviewData.redPlayers instanceof Array) && 
        (playersPreviewData.bluePlayers instanceof Array) && 
        (playersPreviewData.standbyPlayers instanceof Array))) { // Prevents DoS.
    console.log("ERROR: Sending email failed - check playersPreviewData player lists are valid arrays")
    return;
  }
  // now generate email and send
  var emailSubject = "STANDBY ADMIN " + playersPreviewData.gameWeek + " [ADMIN Footie, Goodwin, 6pm Mondays]\n"
  var emailBody = emailPrefix + "\n" + playersPreviewData.gameWeek + "\n";
  emailBody += "Check teams and edit list here:\n"
  emailBody += "https://tensile-spirit-360708.nw.r.appspot.com/admin-team-preview\n"
  emailBody += "\nREDS";
  for (var i = 0; i < playersPreviewData.redPlayers.length; i ++) {
    emailBody += "\n" + playersPreviewData.redPlayers[i];
  }
  emailBody += "\n\nBLUES";
  for (var i = 0; i < playersPreviewData.bluePlayers.length; i ++) {
    emailBody += "\n" + playersPreviewData.bluePlayers[i];
  }
  emailBody += "\n\nSTANDBY";
  for (var i = 0; i < playersPreviewData.standbyPlayers.length; i ++) {
    emailBody += "\n" + playersPreviewData.standbyPlayers[i];
  }
  teamUtils.sendAdminEvent(EMAIL_TYPE_TEAMS_ADMIN, emailSubject, emailBody);
}


// generate email text and send it
async function getBankHolidayJson() {
  // Check if cache needs clearing
  var diffSeconds = (new Date().getTime() - bankHolidaysCacheLastRefresh.getTime()) / 1000;
  if (diffSeconds > bankHolidaysMaxCacheSecs) {
    bankHolidaysCache = {};
    console.log('CLEARED CACHE as diffSeconds was:' + diffSeconds);
  }

  // get the latest bank holidays if not already cached
  if (bankHolidaysCache && Object.keys(bankHolidaysCache).length === 0) {
    try {
      bankHolidaysCache = await downloadPage("https://www.gov.uk/bank-holidays.json");
      console.log("Got NEW bank holidays: " + Object.keys(bankHolidaysCache).length)
    } catch (err) {
      bankHolidaysCache = {};
      console.log("ERROR retrieving NEW bank holidays - proceeding without them...", err)
    }
  } else {
    console.log("Using CACHED bank holidays: " + Object.keys(bankHolidaysCache).length)
  }

  return bankHolidaysCache;
}
