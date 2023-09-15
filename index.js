const express = require('express')
const path = require('path')
const PORT = process.env.PORT || 5000
const https = require('https')
const ical = require('node-ical');
const request = require('request');
const session = require('express-session');
const nodemailer = require('nodemailer');
const fs = require('fs');
const jsdom = require('jsdom');


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
(process.env.FIRESTORE_EMULATOR_HOST) ? console.log("RUNNING LOCALLY WITH FIREBASE EMULATOR") : true;

// store a cache of the data for X seconds
// useful to allow a quick refresh of the screen to randomise players
var nextMonday = new Date();
var monthDateNumericFormat = new Intl.DateTimeFormat('en', { month: '2-digit' });
var bankHolidaysCache = {};
var bankHolidaysCacheLastRefresh = new Date();
var bankHolidaysMaxCacheSecs = 86400; // 1 day
var attendanceMapByYearCache = {};
var rawDatabaseCache = {};
const PLAYER_UNIQUE_FILTER = "PLAYER_UNIQUE_FILTER_TYPE";
const PLAYER_LOG_FILTER = "PLAYER_LOG_FILTER_TYPE";
const COST_PER_GAME = 4;

const app = express();
app.use(session({
  resave: false,
  saveUninitialized: true,
  secret: 'SECRET' 
}));
/*  PASSPORT SETUP (for OAuth) */
const passport = require('passport');
var userProfile;
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser(function(user, cb) { cb(null, user); });
passport.deserializeUser(function(obj, cb) { cb(null, obj); });
/*  Google AUTH  */
const GoogleStrategy = require('passport-google-oauth').OAuth2Strategy;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = (process.env.GOOGLE_CALLBACK_URL) ? process.env.GOOGLE_CALLBACK_URL : "http://localhost:5000/auth/google/callback";
const ALLOWED_ADMIN_EMAILS = (process.env.ALLOWED_ADMIN_EMAILS) ? process.env.ALLOWED_ADMIN_EMAILS : "philroffe@gmail.com";

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

passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL
  },
  function(accessToken, refreshToken, profile, done) {
    var allowedUsers = ALLOWED_ADMIN_EMAILS.split(",");
    if (profile) {
      if (allowedUsers.includes(profile["_json"].email)) {
        userProfile = profile;
      } else {
        userProfile = undefined;
        console.warn("WARNING: Denied attempt to login from unknown user: " + profile["_json"].email);
      }
    }
    return done(null, userProfile);
  }
));
app.get('/auth/google', passport.authenticate('google', { scope : ['profile', 'email'] }));
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/error' }),
  function(req, res) {
    // Successful authentication, redirect success.
    res.redirect('/poll');
});

app.use(express.static(path.join(__dirname, 'public')))
.use(express.urlencoded({ extended: true }))
.use(express.json())
.set('views', path.join(__dirname, 'views'))
.set('view engine', 'ejs')
.get('/', (req, res) => res.render('pages/index'))
.get('/login', (req, res) => res.render('pages/auth'))
.get('/error', (req, res) => res.send("error logging in - invalid account for this site"))
.get('/logout', function(req, res, next){
  req.logout(function(err) {
    if (err) { return next(err); }
    userProfile = undefined;
    res.redirect('/poll');
  });
})
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
    var mondaysDates = mondaysInMonth(Number(gameMonth), Number(gameYear));  //=> [ 7,14,21,28 ]
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
    res.json({'result': 'OK'})
  } else {
    res.sendStatus(400);
  }
})
.post('/_ah/mail/payment@tensile-spirit-360708.appspotmail.com', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT /_ah/mail/payment@... PAYMENT POST FROM EMAIL:', ip, req.body);
  try {
    var body = "";
    await req.on('readable', function() {
      body += req.read();
    });
    req.on('end', function() {
      // extract just the html from the paypal email
      var startPaypalIndex = body.indexOf("@paypal.co.uk");
      var startPaypalHtmlIndex = body.indexOf("<html", startPaypalIndex);
      var endPaypalHtmlIndex = body.indexOf("</html>", startPaypalIndex);
      var html = body.substring(startPaypalHtmlIndex, endPaypalHtmlIndex + 7);
      // join back to one line and use JSDOM to allow parsing
      html = html.replace(/(=\n)/g, '');
      const dom = new jsdom.JSDOM(html);

      // now loop through the body of the html and extract the relevant text
      var payeeName;
      var amount;
      var transactionId;
      var transactionDate;
      var bodyTextArray = dom.window.document.querySelector("body").textContent.split('\n');
      for (i=0; i<bodyTextArray.length; i++) {
        var thisString = bodyTextArray[i].trim();
        //console.log("Line:", thisString)
        if (thisString) {
          var payeeNameMatch = thisString.match(/(.*)( has sent you)(.*)/);
          if (payeeNameMatch) {
            payeeName = payeeNameMatch[1];
            // sometimes can get the amount here too, but paypal is inconsistent so not using it
            //amount = payeeNameMatch[3].replace(/.*=C2=A3/, '').replace(/=C2.*/, '');
          } else if (thisString.startsWith("Transaction ID")) {
            // get value of next line
            transactionId = thisString.replace("Transaction ID", "");
          } else if (thisString.startsWith("Transaction date")) {
            // get value of next line
            transactionDate = new Date(thisString.replace("Transaction date", ""));
          } else if (thisString.startsWith("Amount received")) {
            // get value of next line (and replace the strange chars)
            amount = Number(bodyTextArray[i+1].replace(/.*=C2=A3/, '').replace(/=C2.*/, ''));
            // this is the last message so quit loop
            i = bodyTextArray.length;
          }
        }
      }
      console.log("Parsed paypal email:", payeeName, amount, transactionId, transactionDate);

      // save the details
      var saveSuccess = receivePaymentEmail(payeeName, amount, transactionId, transactionDate);

      if (saveSuccess) {
        res.json({'result': 'OK'})
      } else {
        res.sendStatus(400);
      }
    });
  } catch (err) {
    console.error(err);
    res.json({'result': err})
  }
})
.post('/_ah/mail/teams@tensile-spirit-360708.appspotmail.com', async (req, res) => {
  console.log('Got /_ah/mail/teams@... with Content-Type:', req.get('Content-Type'));
  try {

    var body = "";
    await req.on('readable', function() {
      body += req.read();
    });
    req.on('end', function() {
      var bodyArray = body.split('\n');

      // loop through the email, line-by-line, and extract the payers for each team
      // assumes REDS first, BLUES second!
      var cleanRedTeamPlayers = [];
      var cleanBlueTeamPlayers = [];
      var gameDate;
      for (i=0; i<bodyArray.length; i++) {
        //console.log("Testing", i, bodyArray[i]);
        var currentUpperCaseText = bodyArray[i].trim().toUpperCase();
        if (currentUpperCaseText.startsWith("REDS")) {
          // found the reds team, now parse it
          var redsIndex = i;
          if (cleanRedTeamPlayers.length == 0) {
            cleanRedTeamPlayers = parsePlayerTeamNames(bodyArray, i);
          }
        } else if (currentUpperCaseText.startsWith("BLUE")) {
          var blueIndex = i;
          if (cleanBlueTeamPlayers.length == 0) {
            cleanBlueTeamPlayers = parsePlayerTeamNames(bodyArray, i);
          }
        } else if (currentUpperCaseText.startsWith("DATE:")) {
          // update the date until the REDS players are found
          if (cleanRedTeamPlayers.length == 0) {
            // clean the date ready for parsing
            var dateText = currentUpperCaseText.split(" AT")[0];
            var emailDate = new Date(dateText.split("DATE: ")[1]);
            //calc date - use the next Monday after the email date
            gameDate = getDateNextMonday(emailDate);
            //console.log('WORKING DATE:', dateText, emailDate, gameDate);
          }
        }
      }
      console.log("REDS", redsIndex, cleanRedTeamPlayers);
      console.log("BLUES", blueIndex, cleanBlueTeamPlayers);
      console.log("DATE", dateText, emailDate);

      // save the details
      var saveSuccess = saveTeamsAttendance(gameDate, cleanRedTeamPlayers, cleanBlueTeamPlayers);

      if (saveSuccess) {
        res.json({'result': 'OK'})
      } else {
        res.sendStatus(400);
      }
    });
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
        var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
        
        // read the list of players and aliases
        var playerAliasMaps = {};
        playerAliasMaps = await getDefinedPlayerAliasMaps();
        rowdata.playerAliasMaps = playerAliasMaps;

        var allAttendanceData = await queryDatabaseAndCalcGamesPlayedRatio(req.query.date, 12);
        rowdata.allAttendanceData = allAttendanceData;


        var nextMonday = getDateNextMonday();
        var calcPaymentsFromDate = nextMonday;
        if (req.query.date) {
          calcPaymentsFromDate = req.query.date;
        }
        var outstandingPayments = await queryDatabaseAndBuildOutstandingPayments(calcPaymentsFromDate);
        rowdata.outstandingPayments = outstandingPayments;
        console.log('OUTSTANDING PAYMENTS data' + JSON.stringify(outstandingPayments));
        
        // combine database data with supplimentary game data and render the page
        var pageData = { 'data': rowdata, 'nextMonday': nextMonday.toISOString() };
        if (userProfile) {
          //console.log(userProfile["_json"]);
          pageData.user = userProfile["_json"];
        }
        res.render('pages/poll-generate-teams', { pageData: pageData} );
      } catch (err) {
        console.error(err);
        res.send("Error " + err);
      }
    })
.get('/stats', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('Stats access from IP:' + ip + " with user-agent:" + req.get('User-Agent'));
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
    var pageData = { data: rowdata, };

    res.render('pages/stats', { pageData: pageData } );
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
      var bankHolidaysFile;
      try {
        bankHolidaysFile = await downloadPage("https://www.gov.uk/bank-holidays.json")
        bankHolidaysCache = JSON.parse(bankHolidaysFile);
        console.log("Got NEW bank holidays: " + Object.keys(bankHolidaysCache).length)
      } catch (err) {
        bankHolidaysCache = {};
        console.log("ERROR retrieving NEW bank holidays - proceeding without them...", err)
      }
    } else {
      console.log("Using CACHED bank holidays: " + Object.keys(bankHolidaysCache).length)
    }
    // combine database data with any additional page data
    var pageData = { data: rowdata, bankHolidays: bankHolidaysCache, selectTab: tabName };
    if (userProfile) {
      //console.log(userProfile["_json"]);
      pageData.user = userProfile["_json"];
    }

    var playerAliasData = {};
    if (userProfile) {
      //console.log('Generating ALIASES page with data');
      var playerAliasDoc = await firestore.collection("ADMIN").doc("_aliases").get();
      playerAliasData = playerAliasDoc.data();
      if (!playerAliasData) {
        playerAliasData = {};
      }
    }
    pageData.playerAliasData = playerAliasData;

    res.render('pages/poll', { pageData: pageData } );
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
        var pageData = { data: rowdata, nextMonday: nextMonday.toISOString() };
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
    var headerPostfix = " [Footie, Goodwin, 6pm Mondays]";
    sendAdminEvent("[Player Change Event] " + playerName + headerPostfix, playerName + "\n" + eventDetails);

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
      // if you got here without an exception then everything was successful
      //res.sendStatus(200);
      //res.redirect('/poll');
      res.json({'result': 'OK'})
    } catch (err) {
      console.error(err);
      res.send({'result': err});
    }
  })
.post('/save-week-attendance', async (req, res) => {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log('Got /save-week-attendance POST:', ip, JSON.stringify(req.body));
    
    if (!userProfile) {
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
        // copy the existing doc to preserve a history
        var existingDocData = existingDoc.data();
        existingDocData.saveType = "ATTENDANCE_BACKUP"
        const backupDocRef = firestore.collection(gamesCollectionId).doc("_attendance_" + existingDocData.timestamp);
        backupDocRef.set(existingDocData)
        // now update with the new data
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

  if (!userProfile) {
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
.post('/admin-save-aliases', async (req, res) => {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log('Got /admin-save-aliases POST:', ip, JSON.stringify(req.body));

    if (!userProfile) {
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
  
  if (!userProfile) {
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
  var emailResult = sendEmailToList(mailOptions, req.hostname);

  if (emailResult) {
    res.json({'result': 'OK'})
  } else {
    res.sendStatus(400);
  }
})
.get('/schedule/send-weekly-teams', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log("Scheduling weekly teams GET", ip, req.get('X-Appengine-Cron'));
  //could also restrict by IP (ip == '0.1.0.2' || ip.endsWith('127.0.0.1'))
  if ((req.get('X-Appengine-Cron') === 'true') 
    && (ip.startsWith('0.1.0.2') || ip.endsWith('127.0.0.1'))) {
    // choose the algorithm to us to select the teams
    var algorithmType = "algorithm3";

    // TODO find a better way to import the library as a module rather than as a file
    var nextMonday = getDateNextMonday();
    eval(fs.readFileSync('./views/pages/generate-teams-utils.js')+'');

    var nextMonday = getDateNextMonday(new Date());
    var gameYear = nextMonday.getFullYear();
    var gameMonth = nextMonday.toISOString().split('-')[1];
    var dateString = gameYear + "-" + gameMonth + "-01";

    console.log('Schedule - Generating TEAMS page with data for date: ', dateString);
    //calc date - use the next Monday after the email date
    var rowdata = await queryDatabaseAndBuildPlayerList(dateString);
    var players = rowdata.players;

    // read the list of players and aliases
    var playerAliasMaps = {};
    playerAliasMaps = await getDefinedPlayerAliasMaps();
    var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];

    //
    var mondaysDates = mondaysInMonth(nextMonday.getMonth()+1, nextMonday.getFullYear());  //=> [ 7,14,21,28 ]
    var nextMondayOptionIndex = getNextMondayIndex(mondaysDates, nextMonday);
    console.log("mondaysDates:", mondaysDates, nextMondayOptionIndex);

    // change the algorithm for all players and regenerate teams
    var allAttendanceData = await queryDatabaseAndCalcGamesPlayedRatio(nextMonday, 12);
    var playersGamesPlayedRatio = changeAlgorithmForPlayers(algorithmType, players, allAttendanceData, aliasToPlayerMap, nextMondayOptionIndex);

    // get the list of people on the email list
    var emailTo = Object.values(playerAliasMaps.activeEmailList);

    // now generate the email text and send it
    var emailDetails = generateTeamsEmailText(playersGamesPlayedRatio.generatedTeams, nextMonday);
    var mailOptions = {
      from: GOOGLE_MAIL_FROM_NAME,
      to: emailTo,
      subject: emailDetails.emailSubject,
      text: emailDetails.emailBody
    };
    
    var emailResult = sendEmailToList(mailOptions, req.hostname);

    res.json({'result': 'OK'});
  } else {
    console.log("ERROR: Denied - internal endpoint only");
    res.status(403).end();
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

// wrap a request in an promise
function downloadPage(url) {
  return new Promise((resolve, reject) => {
    request(url, (error, response, body) => {
      if (error) reject(error);
      if (response && response.statusCode != 200) {
        reject('Invalid status code <' + response.statusCode + '>');
      }
      resolve(body);
    });
  });
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
      Object.keys(playerPaymentData).sort().forEach(function(transaction) {
      //console.log('GOT transaction:', playerName, transaction, playerPaymentData[transaction]);
        if (transaction.startsWith("charge_")) {
          // TODO: Consider whether noOfMonths is still needed and if a filter is needed
          totalCharges += playerPaymentData[transaction].amount;
        }
        if (transaction.startsWith("payment_")) {
          totalPayments += playerPaymentData[transaction].amount;
        }
      })
      //console.log('GOT player payment data:', playerName, totalCharges, totalPayments);
      var outstandingBalance = totalCharges + totalPayments;
      if (outstandingBalance < 0) {
        totalAmountOwed = (totalCharges * -1);
        totalNoGames = (totalAmountOwed / COST_PER_GAME) - (totalPayments / COST_PER_GAME);
        totalOutstandingBalance = (outstandingBalance * -1);
        playersUnPaid[playerName] = { "numberOfGames": totalNoGames, "amountOwed": (outstandingBalance * -1), "amountPaid": 0, "outstandingBalance": totalOutstandingBalance}
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
    var playerActive = playerAliasMap[key].active;
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

function mondaysInMonth(m,y) {
  var days = new Date(y,m,0).getDate();
  var mondays =  new Date(m +'/01/'+ y).getDay();
  if (mondays != 1){
    mondays = 9 - mondays;
  }
  mondays = [mondays];
  //console.log(mondays);
  for (var i = mondays[0] + 7; i <= days; i += 7) {
    mondays.push(i);
  }
  return mondays;
}


// get the official name from a map of aliases (using case insensitive search)
function getOfficialNameFromAlias(nameToCheck, aliasToPlayerMap) {
  nameToCheck = nameToCheck.trim();
  var officialName = undefined;
  var fullAliasList = Object.keys(aliasToPlayerMap);
  for (var i = 0; i < fullAliasList.length; i++) { 
    if (nameToCheck.toUpperCase() == fullAliasList[i].toUpperCase()) {
      officialName = aliasToPlayerMap[nameToCheck.toUpperCase()]
    }
  }
  /*if (!officialName) {
    console.log("WARNING: Failed to find official name for:", nameToCheck);
  }*/
  return officialName;
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
  var mondaysDates = mondaysInMonth(Number(gameMonth), Number(gameYear));  //=> [ 7,14,21,28 ]

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

// send an email to the admins to notify of certain events (such as a player availability change)
function sendAdminEvent(title, details) {
  var mailOptions = {
    from: "philroffe+footie@gmail.com",
    to: "philroffe@gmail.com",
    subject: title,
    html: "<pre>" + details + "</pre>"
  };
  console.log(mailOptions);

  transporter.sendMail(mailOptions, function(error, info){
    console.log('Trying to send admin email: ', mailOptions);
    if (error) {
      console.log(error);
      return false;
    } else {
      console.log('Admin email sent: ' + info.response);
      return true;
    }
  });
}

// send an email to the admins to notify of certain events (such as a player availability change)
function sendEmailToList(mailOptions, hostname) {
  if (!hostname || hostname == "localhost") {
    // if localhost then force testing emails only
    mailOptions.to = ['Phil R Test1 <philroffe+Test1@gmail.com>'];
    console.log('FORCING SENDING _TEST_ MSG BECAUSE RUNNING LOCALLY');
  }

  transporter.sendMail(mailOptions, function(error, info){
    console.log('Trying to send admin email: ', mailOptions);
    if (error) {
      console.log(error);
      return false;
    } else {
      console.log('Admin email sent: ' + info.response);
      return true;
    }
  });
}

// save players that played for each team
async function saveTeamsAttendance(gameDate, redTeamPlayers, blueTeamPlayers, rawSourceData = undefined) {
 try {
   var gameDateString = gameDate.toISOString().split('T')[0]; //2023-11-27
   var gameMonth = gameDateString.slice(0, -3); //2023-11
   var gamesCollectionId = "games_" + gameMonth + "-01";

   // find the index for the week
   var mondaysDates = mondaysInMonth(gameDate.getMonth()+1, gameDate.getFullYear());  //=> [ 7,14,21,28 ]
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
     var officialPlayerName = getOfficialNameFromAlias(playerName, aliasToPlayerMap);
     playerName = (officialPlayerName) ? officialPlayerName : playerName;
     allPlayers[playerName] = 1;
   }
   for(var i = 0; i < blueTeamPlayers.length; i++) {
     var playerName = blueTeamPlayers[i].replace(/\d+/g, '').replace(/\*/g, '').trim();
     // check if there is an official name
     var officialPlayerName = getOfficialNameFromAlias(playerName, aliasToPlayerMap);
     playerName = (officialPlayerName) ? officialPlayerName : playerName;
     allPlayers[playerName] = 2;
   }
   attendanceDetails[weekNumber] = allPlayers;

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
     if (!existingDocData[weekNumber] || !existingDocData[weekNumber].scores) {
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
function parsePlayerTeamNames(playerArray, startIndex) {
  var nameArray = [];
  for (j=0; j<11; j++) {
    var cleanName = playerArray[startIndex+j+1].trim().replace(/^\d/, '').replace(/^\./g, '').replace(/^/g, '').replace(/\*+/i, '').trim();
    //.replace(/(red.*|BLUE.*|\*+)/i, '').trim();
    if (cleanName.toUpperCase().startsWith("BLUE") 
      || cleanName.toUpperCase().startsWith("RED") 
      || cleanName.toUpperCase().startsWith("STAND")
      || cleanName.toUpperCase() == "") {
      // found the header/blank so exit from the loop
      //console.log("Exiting loop here:", j, cleanName);
      break;
    } else if (cleanName) {
      //console.log("Adding player to team", j, cleanName);
      nameArray.push(cleanName);
    }
  }
  return nameArray;
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
  var officialPlayerName = getOfficialNameFromAlias(payeeName, aliasToPlayerMap);

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
