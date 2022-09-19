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

express()
.use(express.static(path.join(__dirname, 'public')))
.use(express.urlencoded({ extended: true }))
.use(express.json())
.set('views', path.join(__dirname, 'views'))
.set('view engine', 'ejs')
.get('/', (req, res) => res.render('pages/index'))
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
.get('/poll', async (req, res) => {
  try {
    console.log('Rendering POLL page with data' + req.query.date);
    var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
    // combine database data with any additional page data
    var pageData = { data: rowdata };
    res.render('pages/poll', { pageData: pageData } );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.post('/save-result', async (req, res) => {
    console.log('Got POST query:', req.body);
    var gameMonth = req.body.gameMonth;
    var gameYear = req.body.gameYear;
    var playerName = req.body.playerName;
    var playerAvailability = req.body.playerAvailability;
    var saveType = req.body.saveType;
    var originalPlayerName = (originalPlayerName === undefined) ? "" : req.body.originalPlayerName;

    
    gameId = gameYear + "-" + gameMonth + "-01";
    var timestamp = new Date();
    const gamedetails_new = { "gameid": gameId, "timestamp": timestamp, 
    "playerName": playerName, "playerAvailability": playerAvailability, 
    "saveType": saveType, "originalPlayerName": originalPlayerName, "source_ip": req.ip };

    console.log('Inserting DB data:', JSON.stringify(gamedetails_new));
    try {
      //await datastore.save({ key: datastore.key("games_" + gameId), data: gamedetails_new})
      const docRef = firestore.collection("games_" + gameId).doc(playerName + "_" + timestamp.toISOString());
      await docRef.set(gamedetails_new);

      var playerSummary = await queryDatabaseAndBuildPlayerList(gameId);
      await firestore.collection("games_" + gameId).doc("_summary").set(playerSummary);
      // if you got here without an exception then everything was successful
      //res.sendStatus(200);
      res.json({'result': 'OK'})
    } catch (err) {
      console.error(err);
      res.send("Error " + err);
    }
  })
.get('/dbconvert', async (req, res) => {
  try {
    console.log('Performing DBConvert from postgresql to firebase: ' + req.query.date);
    //var gameId = req.query.date;
    var saveType = "NEW"
    var originalPlayerName = "";

    // read postgresql data
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    const client = await pool.connect();
    const dbresult = await client.query('SELECT * FROM games');
    //console.log('dbresult=' + JSON.stringify(dbresult));
    // TODO; this is a workaround and should be replaced with "WHERE" in sql above
    var rowdata = null;
    var timestamp = new Date();
    var varAllPlayers = []
    for (var i = 0; i < dbresult.rows.length; i++) { 
      //if (dbresult.rows[i].gamedetails.pollMonth == monthDateNumericFormat.format(timestamp)) {
        rowdata = dbresult.rows[i];
        console.log(JSON.stringify(rowdata));
        var gameId = rowdata.gameid;
        var gamedetails = rowdata.gamedetails;
        var players = gamedetails.players;
        Object.keys(players).sort().forEach(function(key) {
          playerName = key
          playerAvailability = players[key]
          //thisPlayerAvailability = { [playerName]: playerAvailability }

          // now convert the rowdata to firebase
          var timestamp = new Date();
          const gamedetails_new = { "gameid": gameId, "timestamp": timestamp, "playerName": playerName, 
          "playerAvailability": playerAvailability, 
          "saveType": saveType, "originalPlayerName": originalPlayerName, "source_ip": req.ip };

          varAllPlayers.push(gamedetails_new)
          
          console.log("==== " + i + key + "====");
          console.log(JSON.stringify(gamedetails_new));
        });
      //}
    }

    for (var i = 0; i < varAllPlayers.length; i++) {
    //for (var i = 110; i < 111; i++) {
      playerName = varAllPlayers[i].playerName
      gameId = varAllPlayers[i].gameid

      const docRef = firestore.collection("games_" + gameId).doc(playerName + "_" + new Date().toISOString());
      await docRef.set(varAllPlayers[i]);

      // generate the summary pages if needed
      //var playerSummary = await queryDatabaseAndBuildPlayerList(gameId);
      //await firestore.collection("games_" + gameId).doc("_summary").set(playerSummary);

      console.log(gameId + "******DONE**** ==== " + i + JSON.stringify(varAllPlayers[i]) + "====");
    }
    
    // now render the new result
    var rowdata = await queryDatabaseAndBuildPlayerList(req.query.date);
    var pageData = { data: rowdata };
    res.render('pages/poll', { pageData: pageData } );
  } catch (err) {
    console.error(err);
    res.send("Error " + err);
  }
})
.listen(PORT, () => console.log(`Listening on ${ PORT }`))


function createJsonDiff(obj1, obj2) {
  var ret = {};
  for(var i in obj2) {
    if(!obj1.hasOwnProperty(i) || obj2[i] !== obj1[i]) {
      ret[i] = obj2[i];
    }
  }
  return ret;
};

function getDateNextMonday() {
  // Get the date next Monday
  nextMonday = new Date();
  if ((nextMonday.getDay() == 1) && (nextMonday.getHours() >= 19)) {
    // date is a Monday after kick-off time (6-7pm), so jump forward a day to force the next week
    nextMonday.setDate(nextMonday.getDate() + 1);
    console.log('Currently a Monday after kick-off so adding a day to:' + nextMonday.toISOString());
  }
  nextMonday.setDate(nextMonday.getDate() + (1 + 7 - nextMonday.getDay()) % 7);
  console.log('Next Monday:' + nextMonday.toISOString());
  return nextMonday;
}

async function queryDatabaseAndBuildPlayerList(reqDate) {
  var requestedDate = new Date();
    if (reqDate) {
      requestedDate = new Date(reqDate);
    } else {
      // if date not specified just default to beginning of this month
      requestedDate.setDate(1);
    }
    var requestedDateMonth = requestedDate.toISOString().split('T')[0]
    //console.log("requestedDateMonth=" + requestedDateMonth)

    // Query database and get all players for games matching this month
    const dbresult = await firestore.collection("games_" + requestedDateMonth).get();
    //console.log('dbresult=' + JSON.stringify(dbresult));

    var rowdata = {};
    if (dbresult.size > 0) {
      // We have data! now build the player list and set it as the players for the front-end
      rowdata = {}
      rowdata.status = "FROM_DATABASE"
      rowdata.gameid = requestedDateMonth
      rowdata.players = buildPlayerList(dbresult);
    } else {
      // create a blank entry to render the poll page
      rowdata = { "status": "NO_DATABASE_ENTRY", "gameid": requestedDateMonth, "players":{}}
    }
    console.log('rowdata=' + JSON.stringify(rowdata));
    return rowdata;
}

function buildPlayerList(dbresult) {
  //loop through all rows and merge the player data into one map
  var playerdata = {};
  dbresult.forEach((doc) => {
    //console.log(doc.id, '=>', doc.data());
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
        default:
          console.log('WARN - Skipping player:' + playerName + ' Unknown saveType:' + saveType);
      }
  });
  console.log('AllPlayers=' + JSON.stringify(playerdata));
  return playerdata;
}
