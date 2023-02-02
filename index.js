const express = require('express')
const path = require('path')
const PORT = process.env.PORT || 5000
const https = require('https')
const ical = require('node-ical');
const request = require('request');

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

// store a cache of the data for X seconds
// useful to allow a quick refresh of the screen to randomise players
var nextMonday = new Date();
var monthDateNumericFormat = new Intl.DateTimeFormat('en', { month: '2-digit' });
var bankHolidaysCache = {};
var attendanceMapByYearCache = {};
var cacheLastRefresh = new Date();
var maxCacheSecs = 86400; // 1 day
const PLAYER_UNIQUE_FILTER = "PLAYER_UNIQUE_FILTER_TYPE";
const PLAYER_LOG_FILTER = "PLAYER_LOG_FILTER_TYPE";

express()
.use(express.static(path.join(__dirname, 'public')))
.use(express.urlencoded({ extended: true }))
.use(express.json())
.set('views', path.join(__dirname, 'views'))
.set('view engine', 'ejs')
.get('/', (req, res) => res.render('pages/index'))
.post('/services/payment', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT PAYMENT POST FROM EMAIL:', ip, req.body);
  var emailDate = new Date(req.body.email_sent_date.split(' at')[0]);
  var transactionDate = new Date(req.body.transaction_date);
  var transactionId = req.body.transaction_id;
  var payeeName = req.body.payee_name.replace(/:/, '');
  var amountReceived = req.body.amount_received;

  // read the list of players and aliases
  var playerAliasMaps = {};
  playerAliasMaps = await getDefinedPlayerAliasMaps();
  var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];
  var officialPlayerName = getOfficialNameFromAlias(payeeName, aliasToPlayerMap);

  try {
    //TODO identify previous month (emailDate.getMonth()-1);
    var gameMonth = "01"
    var gameYear = emailDate.getFullYear();
    var paydetails = {};
    var amount = Number(amountReceived.split(' ')[0].replace(/£/, ''));
    paydetails[officialPlayerName] = amount;

    console.log('Inserting payment DB data:', JSON.stringify(paydetails));

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
.post('/services/teams', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('GOT TEAMS POST FROM EMAIL:', ip, req.body);
  var emailDate = new Date(req.body.Email_Sent_Date.split(' at')[0]);
  var emailSubjectGameDate = new Date(req.body.Subject_Game_Date + " 2023");
  var redTeam = req.body.Red_Team;
  var blueTeam = req.body.Blue_Team;

  try {
    //calc date - use the next Monday after the email date
    var nextMonday = getDateNextMonday(emailDate);
    var nextMondayString = nextMonday.toISOString().split('T')[0]; //2023-11-27
    var gameMonth = nextMondayString.slice(0, -3); //2023-11
    var gamesCollectionId = "games_" + gameMonth + "-01";

    // find the index for the week
    var mondaysDates = mondaysInMonth(nextMonday.getMonth()+1, nextMonday.getFullYear());  //=> [ 7,14,21,28 ]
    var weekNumber = -1;
    for (var i = 0; i < mondaysDates.length; i ++) {
      if (mondaysDates[i] == nextMonday.getDate()) {
        weekNumber = i;
        console.log("Found date:" + nextMonday + " with index:" + weekNumber);
        break;
      }
    }

    // read the list of players and aliases
    var playerAliasMaps = {};
    playerAliasMaps = await getDefinedPlayerAliasMaps();
    var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];

    var timestamp = new Date();
    var saveType = "ATTENDANCE"
    var attendanceDetails = { "month": gameMonth, "timestamp": timestamp, "saveType": saveType, "source_ip": "mailparser.io " + ip };

    var allPlayers = {};
    var redTeamPlayers = redTeam.split('\n')
    for(var i = 0; i < redTeamPlayers.length; i++) {
      var playerName = redTeamPlayers[i].replace(/\d+/g, '').replace(/\*/g, '').trim();
      // check if there is an official name
      var officialPlayerName = getOfficialNameFromAlias(playerName, aliasToPlayerMap);
      playerName = (officialPlayerName) ? officialPlayerName : playerName;
      allPlayers[playerName] = 1;
    }
    var blueTeamPlayers = blueTeam.split('\n')
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
        // scores already in so manually create - be careful
        // store in dead letter queue
        const docRef = firestore.collection("INBOUND_EMAILS").doc(emailSubjectGameDate + "_" + emailDate);
        await docRef.set(req.body);
      }
    }
    res.json({'result': 'OK'})
  } catch (err) {
    console.error(err);
    res.send({'result': err});
  }
})
.post('/logging', async (req, res) => {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.error('CLIENT_ERROR:', ip, req.body);
  res.json({'result': 'OK'});
  })
.get('/teams', async (req, res) => {
      try {
        console.log('Generating TEAMS page with data');
        var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
        var nextMonday = getDateNextMonday();
        // combine database data with supplimentary game data and render the page
        var pageData = { data: rowdata, nextMonday: nextMonday.toISOString() };
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
  /*var diffSeconds = (new Date().getTime() - cacheLastRefresh.getTime()) / 1000;
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
  var diffSeconds = (new Date().getTime() - cacheLastRefresh.getTime()) / 1000;
  if (diffSeconds > maxCacheSecs) {
    bankHolidaysCache = {};
    console.log('CLEARED CACHE as diffSeconds was:' + diffSeconds);
  }

  try {
    console.log('Rendering POLL page with data' + req.query.date);
    var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
    console.log('SCORES POLL page with data' + JSON.stringify(rowdata.scores));

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
.post('/save-result', async (req, res) => {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log('Got /save-result POST:', ip, JSON.stringify(req.body));
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
      res.json({'result': 'OK'})
    } catch (err) {
      console.error(err);
      res.send({'result': err});
    }
  })
.post('/save-payment', async function (req, res) {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
  console.log('Got /save-payment POST:', ip, JSON.stringify(req.body));
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
.get('/admin-aliases', async (req, res) => {
  try {
    console.log('Generating ALIASES page with data');
    var playerAliasDoc = await firestore.collection("ADMIN").doc("_aliases").get();
    var playerAliasMap = playerAliasDoc.data();
    if (!playerAliasMap) {
      playerAliasMap = {};
    }

    // combine database data with supplimentary game data and render the page
    var pageData = { playerAliasMap: playerAliasMap };

    var rowdata = await queryDatabaseAndBuildPlayerList("2022-12-01");
    //console.log('rowdata......... Generating TEAMS page with data', rowdata);
    res.render('pages/admin-aliases', { pageData: pageData, rowdata: rowdata} );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.post('/admin-save-aliases', async (req, res) => {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log('Got /admin-save-aliases POST:', ip, JSON.stringify(req.body));
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
        paymentData = doc.data().paydetails;
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
    rowdata.paydetails = paymentData;

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
  Object.keys(playerAliasMap).sort().forEach(function(key) {
    //console.log("key", playerAliasMap[key]);
    var officialName = key.trim();
    var playerActive = playerAliasMap[key].active;
    var aliasesList = playerAliasMap[key].aliases;

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

  var playerAliasMaps = { playerToAliasMap: playerAliasMap, aliasToPlayerMap: collapsedPlayerMap };
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
