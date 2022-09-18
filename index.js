const express = require('express')
const path = require('path')
const PORT = process.env.PORT || 5000
const https = require('https')
const ical = require('node-ical');
const request = require('request');

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


// By default, the client will authenticate using the service account file
// specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable and use
// the project specified by the GOOGLE_CLOUD_PROJECT environment variable. See
// https://github.com/GoogleCloudPlatform/google-cloud-node/blob/master/docs/authentication.md
// These environment variables are set automatically on Google App Engine
const {Datastore} = require('@google-cloud/datastore');
// Instantiate a datastore client
const datastore = new Datastore({
  projectId: 'long-door-651',
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
    //client.release();
    } catch (err) {
      console.error(err);
      res.send("Error " + err);
    }
  })
.post('/save-result', async (req, res) => {
    console.log('Got POST query:', req.body);
    var gameMonth = req.body.gameMonth;
    var gameYear = req.body.gameYear;
    var players = req.body.players;
    var saveType = req.body.saveType;
    var originalPlayerName = req.body.originalPlayerName;
    
    gameId = gameYear + "-" + gameMonth + "-01";
    var timestamp = new Date();
    var gamedetails_new = { "gameid": gameId, "timestamp": timestamp, 
    "pollYear": gameYear, "pollMonth": gameMonth, "players": players, 
    "saveType": saveType, "originalPlayerName": originalPlayerName, "source_ip": req.ip };
    gamedetailsNewJson = JSON.stringify(gamedetails_new);
    console.log('Inserting DB data:', gamedetailsNewJson);

    try {
      await datastore.save({ key: datastore.key("games_" + gameId), data: gamedetails_new})
      // if you got here without an exception then everything was successful
      //res.sendStatus(200);
      res.json({'result': 'OK'})
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
    const query = datastore.createQuery("games_" + requestedDateMonth)
      .filter('gameid', '=', requestedDateMonth).order('timestamp', {descending: false});
    const [dbresult] =  await datastore.runQuery(query);
    console.log('dbresult=' + JSON.stringify(dbresult));

    var rowdata = {};
    if (dbresult[0]) {
      // We have data! now build the player list and set it as the players for the front-end
      rowdata = dbresult[0]
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
  for (var i = 0; i < dbresult.length; i++) { 
    players = dbresult[i].players;
    saveType = dbresult[i].saveType;
    originalPlayerName = dbresult[i].originalPlayerName;
    // loop through the player saved info and generate latest playerdata
    Object.keys(players).sort().forEach(function(key) {
      //console.log('player=' + key + "___" + players[key]);
      playerName = key
      playerAvailability = players[key]
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
          text = "Looking forward to the Weekend";
      }
    });
  }
  console.log('AllPlayers=' + JSON.stringify(playerdata));
  return playerdata;
}