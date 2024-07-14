const express = require('express')
const path = require('path')
const PORT = process.env.PORT || 5000
const https = require('https')
const compression = require('compression');
const session = require('express-session');
const nodemailer = require('nodemailer');
const fs = require('fs');
const mimelib = require("mimelib");
const { convert } = require('html-to-text');
const simpleParser = require('mailparser').simpleParser;
const teamUtils = require("./views/pages/generate-teams-utils.js");
const passport = require('passport');

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
const GOOGLE_MAIL_USERNAME = (process.env.GOOGLE_MAIL_USERNAME) ? process.env.GOOGLE_MAIL_USERNAME : "NOT_SET";
const GOOGLE_MAIL_APP_PASSWORD = (process.env.GOOGLE_MAIL_APP_PASSWORD) ? process.env.GOOGLE_MAIL_APP_PASSWORD : "NOT_SET";
var transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GOOGLE_MAIL_USERNAME,
    pass: GOOGLE_MAIL_APP_PASSWORD
  }
});

const app = express();
app.use(compression());

// enable google auth
var authRouter = require('./routes/auth');
var lastLocationBeforeLogin = '/';

app.use(express.static(path.join(__dirname, 'public')))
.use(express.urlencoded({ extended: true }))
.use(express.json())
.set('views', path.join(__dirname, 'views'))
.set('view engine', 'ejs')

.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false, // don't save session if unmodified
  saveUninitialized: false // don't create session until something stored
}))
.use(passport.authenticate('session'))
.use(function(req, res, next) {
  var msgs = req.session.messages || [];
  res.locals.messages = msgs;
  res.locals.hasMessages = !! msgs.length;
  req.session.messages = [];
  next();
})
.use('/', authRouter)
.get('/login', function(req, res, next) {
  // a hack that won't scale past a single user logging in at a time
  // store the referer on login attempt, to allow redirect after successful login
  lastLocationBeforeLogin = (req.headers.referer) ? req.headers.referer : '/';
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
      var playerList = attendanceData[weekNumber];
      if (playerList) {
        Object.keys(playerList).forEach(await function(playerName) {
          // check a real player (not the scores) and that the player actually played
          if ((playerName != "scores") && (playerList[playerName] > 0)) {
            var gameWeek = gameId + "_" + weekNumber;

            //const playerLedgerDocRef = firestore.collection("PAYMENTS").doc(playerName);
            const playerLedgerDocRef = firestore.collection("OPEN_LEDGER").doc(playerName);
            var gameDay = mondaysDates[weekNumber];
            if (gameDay < 10) {
              gameDay = "0" + gameDay;
            }
            var thisDate = gameYear + "-" + gameMonth + "-" + gameDay;
            var playerTransactionSavedata = {};
            playerTransactionSavedata["charge_" + thisDate] = { "amount": (COST_PER_GAME * -1) };
            console.log('Adding game cost:', playerName, thisDate, JSON.stringify(playerTransactionSavedata));
            playerLedgerDocRef.set(playerTransactionSavedata, { merge: true });
          }
        });
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
    var playerAliasMaps = {};
    playerAliasMaps = await getDefinedPlayerAliasMaps();
    rowdata.playerAliasMaps = playerAliasMaps;

    // get all daata - used to generate the costs and kitty
    rowdata.allCollectionDocs = await getAllDataFromDB();
    //console.log(rowdata.allCollectionDocs);

    // read the completed payments ledger
    const closedLedgerCollection = firestore.collection("CLOSED_LEDGER");
    const allClosedLedgerDocs = await closedLedgerCollection.get();
    var closedLedgers = {};
    allClosedLedgerDocs.forEach(doc => {
      var key = doc.id;
      var data = doc.data();
      closedLedgers[key] = data;
    })
    rowdata.closedLedgers = closedLedgers;

    // read the open payments ledger
    const openLedgerCollection = firestore.collection("OPEN_LEDGER");
    const allOpenLedgerDocs = await openLedgerCollection.get();
    var openLedgers = {};
    allOpenLedgerDocs.forEach(doc => {
      var key = doc.id;
      var data = doc.data();
      openLedgers[key] = data;
    })
    rowdata.openLedgers = openLedgers;
    
    // combine database data with supplimentary game data and render the page
    var nextMonday = getDateNextMonday();
    var pageData = { 'data': rowdata, 'nextMonday': nextMonday.toISOString(), "environment": environment };
    
    if (req.isAuthenticated()) {
      console.log("User is logged in: ", req.user);
      pageData.user = req.user;
    }

    // render the page and pass some json with stringified value
    res.render('pages/admin-payments-ledger', { pageData: JSON.stringify(pageData) });
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
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
    console.log("User is logged in: ", req.user);
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
.get('/mailing-list', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT MODIFY MAILINGLIST GET FROM:', ip, req.body);
  try {
    // now need to check if confirming subscriptionStatus
    var code = Number(req.query.code);
    var playerAliasData;
    // lookup confirmation code and update the subscriptionStatus as appropriate
    if (code) {
      var playerAliasDoc = await firestore.collection("ADMIN").doc("_aliases").get();
      var playerAliasMap = playerAliasDoc.data();
      var playerConfirmedKey;
      Object.keys(playerAliasMap).sort().forEach(function(key) {
        if (playerAliasMap[key].code == code) {
          playerAliasData = playerAliasMap[key];
          if (playerAliasMap[key].subscriptionStatus != MAIL_SUBSCRIPTION_STATUS_SUBSCRIBED) {
            playerAliasMap[key].subscriptionStatus = MAIL_SUBSCRIPTION_STATUS_SUBSCRIBED;
            playerConfirmedKey = key;
            console.log("CONFIRMED MAILING LIST CODE:", playerAliasData);
          } else {
            console.log("FOUND MAILING LIST CODE BUT ALREADY SUBSCRIBED :", playerAliasData);
          }
        }
      });
      if (playerConfirmedKey) {
        // save the updated alias map
        await firestore.collection("ADMIN").doc("_aliases").set(playerAliasMap);
        var title = "[Mailing List CONFIRMED] " + playerAliasMap[playerConfirmedKey].email + " [Footie, Goodwin, 6pm Mondays]";
        var subject = playerAliasMap[playerConfirmedKey].email + "\n" + playerAliasMap[playerConfirmedKey].subscriptionStatus;
        teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, title, subject);
      }
      if (!playerAliasData) {
        console.log("ERROR FINDING MAILING LIST CODE:", code);
      }
      var pageData = { code: code, playerAliasData: playerAliasData, "environment": environment };
      res.render('pages/mailing-list-confirmation', { pageData: JSON.stringify(pageData)} );
    } else {
      var pageData = { code: code, playerAliasData: playerAliasData, "environment": environment };
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
      // store the data for future processing
      var docNamePrefix = "PAYMENT_ERROR_EMAIL";
      if (body.includes("noreply@sheffield.ac.uk")) {
        docNamePrefix = "PAYMENT_PITCH_EMAIL";
      } else if (body.includes("service@paypal.co.uk")) {
        docNamePrefix = "PAYMENT_PAYPAL_EMAIL";
      }
      var emailDetails = { "parsed_status": "NEW", "type": docNamePrefix, "data": body}
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

  var emailDocname = "TEAMS_EMAIL_" + new Date().toISOString();
  var body;

  var debug = false;
  if (debug) {
    // used for debugging only, uncomment as required
    emailDocname = "TEAMS_EMAIL_2023-11-25T07:11:07.659Z";
    var emailDoc = await firestore.collection("INBOUND_EMAILS").doc(emailDocname).get();
    body = emailDoc.data().data;
    //console.log(body);
  } else {
    try {
      // read the data from the request
      const bodyArray = [];
      let length = 0;
      const contentLength = +req.headers["content-length"];
      var receivedBody = await new Promise((resolve, reject) => {
        let ended = false;
        function onEnd() {
          if (!ended) {
            resolve(Buffer.concat(bodyArray).toString());
            ended = true;
          }
        }
        req.on("data", chunk => {
          bodyArray.push(chunk);
          length += chunk.length;
          if (length >= contentLength) onEnd();
        })
        .on("end", onEnd)
        .on("error", (err) => {
            reject(err);
        });
      });
      // done so convert from quoted-printable mime type
      body = mimelib.decodeQuotedPrintable(receivedBody);
      //console.log(body);
      // store the data for future processing
      var emailDetails = { "parsed_status": "NEW", "data": body}
      const docRef = firestore.collection("INBOUND_EMAILS").doc(emailDocname);
      docRef.set(emailDetails);
    } catch (err) {
      console.error(err);
      res.json({'result': err})
    }
  }

  try {
    // get SCORES if defined (loop through lines, ignoring empty lines, to get the first text and try to parse score)
    var scores;
    let parsed = await simpleParser(body);
    var emailLines = parsed.text.split('\n');
    for (i=0; i<emailLines.length; i++) {
      var currentLine = emailLines[i].trim();
      if (currentLine != "") {
        // non-empty line
        i = emailLines.length;
        var scoreValues = currentLine.split('-');
        var goals1 = Number(scoreValues[0]);
        var goals2 = Number(scoreValues[1]);
        if (isNaN(goals1) || isNaN(goals2)) {
          console.log("NO SCORES FOUND IN BODY, SKIPPING...");
        } else {
          var calcWinner = -1;
          if (goals1 == goals2) {
            calcWinner = 0; // draw
          } else if (goals1 > goals2) {
            calcWinner = 1; // team1 won
          } else if (goals1 < goals2) {
            calcWinner = 2; // team2 won
          }
          scores = {"winner": calcWinner, "team1goals": goals1, "team2goals": goals2}
          //console.log(scores);
        }
      }
    }

    // read the list of players and aliases
    var playerAliasMaps = {};
    playerAliasMaps = await getDefinedPlayerAliasMaps();
    var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];

    // assumes REDS first, BLUES second!
    var redGoalScorers = {};
    var blueGoalScorers = {};
    var gameDate;
    for (i=0; i<emailLines.length; i++) {
      //console.log("Testing", i, emailLines[i]);
      var currentUpperCaseText = emailLines[i].replace(/^>+/g, '').trim().toUpperCase();
      if (currentUpperCaseText.startsWith("RED")) {
        // found the reds team, now parse it
        var redsIndex = i;
        if (Object.keys(redGoalScorers).length == 0) {
          redGoalScorers = parsePlayerTeamNames(emailLines, i, aliasToPlayerMap);
        }
      } else if (currentUpperCaseText.startsWith("BLUE")) {
        var blueIndex = i;
        if (Object.keys(blueGoalScorers).length == 0) {
          blueGoalScorers = parsePlayerTeamNames(emailLines, i, aliasToPlayerMap);
        }
      } else if (currentUpperCaseText.startsWith("DATE:")) {
        // update the date until the REDS players are found
        if (Object.keys(redGoalScorers).length == 0) {
          // clean the date ready for parsing
          var dateText = currentUpperCaseText.split(" AT")[0];
          var emailDate = new Date(dateText.split("DATE: ")[1]);
          //calc date - use the next Monday after the email date
          gameDate = getDateNextMonday(emailDate);
          //console.log('WORKING DATE:', dateText, emailDate, gameDate);
        }
      }
    }
    console.log("DATE", dateText, emailDate);
    console.log("SCORES", scores);
    console.log("RED-GOAL-SCORERS", redGoalScorers);
    console.log("BLUE-GOAL-SCORERS", blueGoalScorers);

    // save the details
    var saveSuccess = saveTeamsAttendance(gameDate, redGoalScorers, blueGoalScorers, scores);
    if (saveSuccess) {
      console.log("SUCCESS: Saved teams from email:", emailDocname);
    } else {
      console.error("ERROR: FAILED TO SAVE TEAMS FROM EMAIL:", emailDocname);
    }
  } catch (err) {
    console.error(err);
  }
  // got here so always send 200 OK messsage (otherwise emails will be retried by google cloud)
  res.json({'result': 'OK'})
})
.post('/logging', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.error('CLIENT_ERROR:', ip, req.body);
  res.json({'result': 'OK'});
  })
.get('/teams', async (req, res) => {
      try {
        console.log('Generating TEAMS page with data for date: ', req.query.date);
        var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
        
        // read the list of players and aliases
        var playerAliasMaps = {};
        playerAliasMaps = await getDefinedPlayerAliasMaps();
        rowdata.playerAliasMaps = playerAliasMaps;

        var allAttendanceData = await queryDatabaseAndCalcGamesPlayedRatio();
        rowdata.allAttendanceData = allAttendanceData;

        var nextMonday = getDateNextMonday();
        var calcPaymentsFromDate = nextMonday;
        if (req.query.date) {
          calcPaymentsFromDate = req.query.date;
        }
        var outstandingPayments = await queryDatabaseAndBuildOutstandingPayments(calcPaymentsFromDate);
        rowdata.outstandingPayments = outstandingPayments;
        console.log('OUTSTANDING PAYMENTS data' + JSON.stringify(outstandingPayments));
        
        // read the teams from the playersPreviewData
        rowdata.playersPreviewData = await getGameWeekPreviewTeams();;
        
        // combine database data with supplimentary game data and render the page
        var pageData = { 'data': rowdata, 'nextMonday': nextMonday.toISOString(), "environment": environment };
        if (req.isAuthenticated()) {
          console.log("User is logged in: ", req.user);
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
    var playerAliasMaps = {};
    playerAliasMaps = await getDefinedPlayerAliasMaps();

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
    console.log('Rendering POLL page with data' + req.query.date);
    var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
    console.log('SCORES POLL page with data' + JSON.stringify(rowdata.scores));

    var nextMonday = getDateNextMonday();
    var calcPaymentsFromDate = nextMonday;
    if (req.query.date) {
      calcPaymentsFromDate = req.query.date;
    }
    var outstandingPayments = await queryDatabaseAndBuildOutstandingPayments(calcPaymentsFromDate);
    rowdata.outstandingPayments = outstandingPayments;
    console.log('OUTSTANDING PAYMENTS data' + JSON.stringify(outstandingPayments));

    var tabName = "";
    if (req.query.tab) {
      tabName = req.query.tab;
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
    // combine database data with any additional page data
    var pageData = { data: rowdata, bankHolidays: bankHolidaysCache, selectTab: tabName, "environment": environment  };

    var playerAliasData = {};
    if (req.isAuthenticated()) {
      console.log("User is logged in: ", req.user);
      pageData.user = req.user;
      //console.log('Generating ALIASES page with data');
      var playerAliasDoc = await firestore.collection("ADMIN").doc("_aliases").get();
      playerAliasData = playerAliasDoc.data();
      if (!playerAliasData) {
        playerAliasData = {};
      }
    }
    pageData.playerAliasData = playerAliasData;

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

      var playerSummary = await queryDatabaseAndBuildPlayerList(gameId);
      // store the current alias maps separately to the rest of the summary
      await firestore.collection(gamesCollectionId).doc("_aliases").set(playerSummary.playerAliasMaps);
      delete playerSummary.playerAliasMaps; // exclude the transient alias maps in the summary
      console.log('Inserting DB summary data:', JSON.stringify(playerSummary));
      await firestore.collection(gamesCollectionId).doc("_summary").set(playerSummary);

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

    var gameWeek = req.body.gameWeek;
    var gameMonth = req.body.gameMonth;
    var gameYear = req.body.gameYear;
    var playersAttended = req.body.playersAttended;
    var scores = req.body.scores;
    var saveType = req.body.saveType;

    var timestamp = new Date();
    var attendanceDetails = { "month": gameYear + "-" + gameMonth, "timestamp": timestamp, 
     "saveType": saveType, "source_ip": ip };
    Object.keys(playersAttended).forEach(function(weekNumber) {
      attendanceDetails[weekNumber] = playersAttended[weekNumber];
    });
    Object.keys(scores).forEach(function(weekNumber) {
      attendanceDetails[weekNumber].scores = scores[weekNumber];
    });

    teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, "[Week Attendance Change] " + gameYear + "-" + gameMonth + " (" + gameWeek + ")", JSON.stringify(attendanceDetails));

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

    var playerAliasMap = req.body.playerAliasMap;

    console.log('Inserting ALIAS data:', JSON.stringify(playerAliasMap));
    try {
      const docRef = firestore.collection("ADMIN").doc("_aliases");
      await docRef.set(playerAliasMap);

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
    && (ip.startsWith('0.1.0.2') || ip.endsWith('127.0.0.1'))) {
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
    && (ip.startsWith('0.1.0.2') || ip.endsWith('127.0.0.1'))) {

    // check if bank holiday
    var nextMonday = getDateNextMonday();
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
    var playersGamesPlayedRatio = await calculateNextGameTeams();
    var playersPreviewData = playersGamesPlayedRatio.generatedTeams;
    playersPreviewData.gameWeek = dateString;

    // save the list for future
    console.log("SAVING", playersGamesPlayedRatio.generatedTeams);
    playersPreviewData.lastUpdated = "Auto: " + new Date().toISOString();
    await firestore.collection("ADMIN").doc("GameWeekPreview").set(playersPreviewData);

    // now generate the email text and send it
    var emailPrefix = "Auto generated teams."
    sendTeamsPreviewEmail(playersPreviewData, emailPrefix);
    res.json({'result': 'OK'});
  } else {
    console.log("ERROR: Denied - internal endpoint only");
    res.status(403).end();
  }
})
.get('/schedule/send-weekly-teams', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log("Scheduling weekly teams GET", ip, req.get('X-Appengine-Cron'));
  if ((req.get('X-Appengine-Cron') === 'true') 
    && (ip.startsWith('0.1.0.2') || ip.endsWith('127.0.0.1'))) {

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
    if (teamUtils.datesAreOnSameDay(previewDate, nextMonday)) {
      console.error("ERROR - No ADMIN-GameWeekPreview data found (should have been generated by Thursday cron)", playersPreviewData);
      var playersGamesPlayedRatio = await calculateNextGameTeams();
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
    await firestore.collection("ADMIN").doc("GameWeekPreview").delete();

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
    await firestore.collection("ADMIN").doc("GameWeekPreview").set(req.body);
    res.json({'result': 'OK'})
  } catch (err) {
    console.error(err);
    res.sendStatus(400);
  }
})
.get('/admin-team-preview', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT ADMIN TEAM-PREVIEW GET FROM:', ip, req.body);
  try {
    var playersPreviewData = await getGameWeekPreviewTeams();
    var pageData = { playersPreviewData: playersPreviewData, "environment": environment };

    //////////////////////////////////////////
    //////////////////////////////////////////
    //////////////////////////////////////////
    // Query database and get all players for games matching this month
    var requestedDateMonth = "2024-02-01"
    const dbresult = await firestore.collection("games_" + requestedDateMonth).orderBy('timestamp', 'asc').get();
    //console.log('dbresult=' + JSON.stringify(dbresult));
    var rowdata = {};
    console.log("QQQ", "games_" + requestedDateMonth)
    if (dbresult.size > 0) {
      // We have data! now build the player list and set it as the players for the front-end
      console.log("PPP")
      rowdata = {}
      rowdata.status = "FROM_DATABASE"
      rowdata.gameid = requestedDateMonth
      //rowdata.playerAliasMaps = playerAliasMaps;
      //if (filterType == PLAYER_LOG_FILTER) {
        rowdata.players = buildPlayerLogList(dbresult);
        pageData.players = rowdata.players;
      //}
    }
    //////////////////////////////////////////
    //////////////////////////////////////////
    //////////////////////////////////////////

    // get all ratio data for comparison
    var allAttendanceData = await queryDatabaseAndCalcGamesPlayedRatio();
    pageData.allAttendanceData = allAttendanceData;

    console.log('Rendering POLL page with data' + req.query.date);
    var rowdata = await queryDatabaseAndBuildPlayerList(new Date(requestedDateMonth));
    pageData.players = rowdata;
    
    res.render('pages/admin-team-preview', { pageData: JSON.stringify(pageData)} );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.listen(PORT, () => console.log(`Listening on ${ PORT }`))

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

async function queryDatabaseAndCalcGamesPlayedRatio() {
  // game scores and win/lose/draw only available from 2023-01-01 (game played available from 2019-08-01)
  var requestedDate = new Date();
  noOfMonths = monthDiff(new Date("2023-01-01"), new Date());

  var allAttendanceData = {};
  for (var i = 0; i <= noOfMonths; i ++) {
    var thisDate = new Date(requestedDate);
    thisDate.setMonth(requestedDate.getMonth() - i);
    var gameYear = thisDate.getFullYear();
    var gameMonth = thisDate.toISOString().split('-')[1];
    var gamesCollectionId = "games_" + gameYear + "-" + gameMonth + "-01";
    console.log('GETTING ATTENDANCE data:', gamesCollectionId);
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
          // TODO: Consider whether noOfMonths is still needed and if a filter is needed
          totalCharges += playerPaymentData[transaction].amount;
          charges.push(transaction.replace('charge_', ''));
        }
        if (transaction.startsWith("payment_")) {
          totalPayments += playerPaymentData[transaction].amount;
          payments.push(transaction);
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
    } else {
      // if date not specified just default to beginning of this month
      requestedDate.setDate(1);
    }
    var requestedDateMonth = requestedDate.toISOString().split('T')[0]
    //console.log("requestedDateMonth=" + requestedDateMonth)

    // read the list of players and aliases
    var playerAliasMaps = {};
    playerAliasMaps = await getDefinedPlayerAliasMaps();
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
    dbresult.forEach((doc) => {
      if (doc.data().saveType == "ATTENDANCE") {
        // assume no more than 4 weeks in a month
        for (var weekNumber = 0; weekNumber < 5; weekNumber ++) {
          attendedData[weekNumber] = doc.data()[weekNumber];
          //console.log('Added Attendance for week: ' + weekNumber + " " + JSON.stringify(attendedData[weekNumber]));

          //extract the scores data out of the attended list
          if (attendedData[weekNumber]) {
            scoresData[weekNumber] = attendedData[weekNumber].scores;
            delete attendedData[weekNumber].scores;
          }
        }
        //paymentData = doc.data().paydetails;
        scoresData.status = (doc.data().status) ? doc.data().status : "open";
        //
      }
    });
    //console.log('LOADED from DB attendedData by week: ' + JSON.stringify(attendedData));

    // transform from {weekNumber: {player1, player2}} to {player: {weekNumber, weekNumber}}
    var attendedDataByPlayer = {};
    Object.keys(attendedData).sort().forEach(function(weekNumber) {
      if (attendedData[weekNumber]) {
        Object.keys(attendedData[weekNumber]).sort().forEach(function(player) {
          if (!attendedDataByPlayer[player]) {
            attendedDataByPlayer[player] = {};
          }
          var playerSelection = attendedData[weekNumber][player];
          attendedDataByPlayer[player][weekNumber] = playerSelection;
        });
      }
    });
    //console.log('TRANSFORMED attendedData by player: ' + JSON.stringify(attendedDataByPlayer));

    rowdata.attendance = attendedDataByPlayer;
    rowdata.scores = scoresData;
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
  console.log('AllPlayers=' + JSON.stringify(playerdata));
  return playerdata;
}

// check for unique player name
async function getDefinedPlayerAliasMaps() {
  var playerAliasDoc = await firestore.collection("ADMIN").doc("_aliases").get();
  var playerAliasMap = playerAliasDoc.data();
  if (!playerAliasMap) {
    playerAliasMap = {};
  }

  var collapsedPlayerMap = {};
  var activeEmailList = {};
  Object.keys(playerAliasMap).sort().forEach(function(key) {
    //console.log("key", playerAliasMap[key]);
    var officialName = key.trim();
    var playerActive = false;
    var subscriptionStatus = playerAliasMap[key].subscriptionStatus;
    if (subscriptionStatus == 2) { playerActive = true; }

    var aliasesList = playerAliasMap[key].aliases;
    var playerEmail = playerAliasMap[key].email;

    if (playerActive && playerEmail) {
      activeEmailList[officialName] = officialName + " <" + playerEmail + ">";
    }

    //collapsedPlayerMap[playerName.toUpperCase()] = playerName;
    collapsedPlayerMap[officialName.toUpperCase()] = officialName;
    for (var i = 0; i < aliasesList.length; i ++) {
      var aliasName = aliasesList[i].trim();
      if (aliasName != "") {
        //collapsedPlayerMap[aliasesList[i].toUpperCase()] = playerName;
        collapsedPlayerMap[aliasName.toUpperCase()] = officialName;
      }
    }
  });

  ///// TODO - fix the sorting
  //playerToAliasMap: new Map([...playerAliasMap].sort()
  //aliasToPlayerMap: new Map([...collapsedPlayerMap].sort())

  var playerAliasMaps = { playerToAliasMap: playerAliasMap, aliasToPlayerMap: collapsedPlayerMap, activeEmailList: activeEmailList };
  return playerAliasMaps;
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
   var playerAliasMaps = {};
   playerAliasMaps = await getDefinedPlayerAliasMaps();
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
   attendanceDetails[weekNumber] = allPlayers;
   if (scores) {
     attendanceDetails[weekNumber].scores = scores;
   }
   attendanceDetails[weekNumber].scores.team1scorers = redGoalScorers;
   attendanceDetails[weekNumber].scores.team2scorers = blueGoalScorers;

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
       const backupDocRef = firestore.collection(gamesCollectionId).doc("_attendance_" + existingDocData.timestamp);
       backupDocRef.set(existingDocData)
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

  // read the list of players and aliases
  var playerAliasMaps = {};
  playerAliasMaps = await getDefinedPlayerAliasMaps();
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
    playerTransactionSavedata[playerTransactionName] = { "amount": amount, "paypalTransactionId": transactionId };
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
  var playerAliasDoc = await firestore.collection("ADMIN").doc("_aliases").get();
  var playerAliasMap = playerAliasDoc.data();
  if (!playerAliasMap) {
    playerAliasMap = {};
  }
  var email = details.email;
  var name = details.name;
  var optIn = details.optIn;

  var mailinglistChanged = false;
  var sendConfirmationEmail = false;
  var foundExistingPlayer = false;
  var playerKey = "";
  Object.keys(playerAliasMap).sort().forEach(function(key) {
    //console.log("key", playerAliasMap[key]);
    if (playerAliasMap[key].email.toUpperCase() == email.toUpperCase()) {
      foundExistingPlayer = true;
      playerKey = key;
      if (optIn) {
        // add/edit to subscribe email
        if (playerAliasMap[key].subscriptionStatus == MAIL_SUBSCRIPTION_STATUS_SUBSCRIBED) {
          // already subscribed so do nothing
          console.log("ALREADY SUBSCRIBED:", key, email, playerAliasMap[key]);
          mailinglistChanged = false;
        } else if (playerAliasMap[key].subscriptionStatus == MAIL_SUBSCRIPTION_STATUS_CONFIRMING) {
          // resend email
          console.log("STILL CONFIRMING - resending confirmation email request:", key, email, playerAliasMap[key]);
          // SEND CONFIRMATION EMAIL NOW
          mailinglistChanged = false;
          sendConfirmationEmail = true;
        } else if (playerAliasMap[key].subscriptionStatus == MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED) {
          // add new email
          console.log("Resubscribing email to mailing list:", key, email, playerAliasMap[key]);
          // SEND CONFIRMATION EMAIL NOW
          playerAliasMap[key].subscriptionStatus = MAIL_SUBSCRIPTION_STATUS_CONFIRMING;
          mailinglistChanged = true;
          sendConfirmationEmail = true;
        }
      } else {
        // remove/unsubscribe email
        if (playerAliasMap[key].subscriptionStatus == MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED) {
          // already unsubscribed so do nothing
          console.log("ALREADY UNSUBSCRIBED:", key, email, playerAliasMap[key]);
          mailinglistChanged = false;
        } else {
          //MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED
          console.log("UNSUBCRIBING:", key, email, playerAliasMap[key]);
          playerAliasMap[key].subscriptionStatus = MAIL_SUBSCRIPTION_STATUS_UNSUBSCRIBED;
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
    if (!playerAliasMap[nameAliasKey]) {
      playerKey = nameAliasKey;
      mailinglistChanged = true;
      sendConfirmationEmail = true;
      // create a new player
      playerAliasMap[playerKey] = {"aliases": [ name ], "subscriptionStatus": MAIL_SUBSCRIPTION_STATUS_CONFIRMING, "email": email};
      console.log("Adding new email to mailing list:", name, email, playerAliasMap[name]);
    } else {
      console.error("ERROR - nameAliasKey already exists", name, email, playerAliasMap[nameAliasKey]);
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
      playerAliasMap[playerKey].date = details.date;
      var code = playerAliasMap[playerKey].date.getTime();
      playerAliasMap[playerKey].code = code;
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
    console.log("UPDATED LIST SO SAVING", playerAliasMap[playerKey]);
    teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, "[Mailing List Change Event] " + email + EMAIL_TITLE_POSTFIX, email + "\n" + playerAliasMap[playerKey].subscriptionStatus);
    await firestore.collection("ADMIN").doc("_aliases").set(playerAliasMap);
  }
  return true;
}


async function calculateNextGameTeams() {
    // choose the algorithm to us to select the teams
    var algorithmType = "algorithm6";
    var nextMonday = getDateNextMonday(new Date());
    var gameYear = nextMonday.getFullYear();
    var gameMonth = nextMonday.toISOString().split('-')[1];
    var dateString = gameYear + "-" + gameMonth + "-01";

    console.log('Generating TEAMS data for date: ', dateString);
    //calc date - use the next Monday after the email date
    var rowdata = await queryDatabaseAndBuildPlayerList(dateString);
    var players = rowdata.players;

    // read the list of players and aliases
    var playerAliasMaps = {};
    playerAliasMaps = await getDefinedPlayerAliasMaps();
    var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];

    //
    var mondaysDates = teamUtils.mondaysInMonth(nextMonday.getMonth()+1, nextMonday.getFullYear());  //=> [ 7,14,21,28 ]
    var nextMondayOptionIndex = teamUtils.getNextMondayIndex(mondaysDates, nextMonday);
    //console.log("mondaysDates:", mondaysDates, nextMondayOptionIndex);

    // read the teams from the playersPreviewData
    var playersPreviewData = await getGameWeekPreviewTeams();

    // change the algorithm for all players and regenerate teams
    var algorithmRange = 12;
    var allAttendanceData = await queryDatabaseAndCalcGamesPlayedRatio();
    var playersGamesPlayedRatio = teamUtils.changeAlgorithmForPlayers(algorithmType, players, playersPreviewData, 
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