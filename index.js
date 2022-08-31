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
.get('/db', async (req, res, next) => {
  // Create a visit record to be stored in the database
  const visit = {
    timestamp: new Date(),
    // Store a hash of the visitor's ip address
    userIp: req.ip,
  };

  try {
    await insertVisit(visit);
    const [entities] = await getVisits();
    const visits = entities.map(
      entity => `Time: ${entity.timestamp}, AddrHash: ${entity.userIp}`
    );
    res
      .status(200)
      .set('Content-Type', 'text/plain')
      .send(`Last 10 visits:\n${visits.join('\n')}`)
      .end();
  } catch (error) {
    next(error);
  }
})
.get('/teams', async (req, res) => {
      try {
        console.log('Rendereing TEAMS page with data');
        const client = await pool.connect();
        const dbresult = await client.query('SELECT * FROM games');
        //console.log('dbresult=' + JSON.stringify(dbresult));

        // TODO; this is a workaround and should be replaced with "WHERE" in sql above
        var rowdata = null;
        for (var i = 0; i < dbresult.rows.length; i++) { 
          if (dbresult.rows[i].gamedetails.pollMonth == monthDateNumericFormat.format(nextMonday)) {
            rowdata = dbresult.rows[i];
          }
        }
        console.log('rowdata=' + JSON.stringify(rowdata));

        if (!rowdata) {
          rowdata = { "status": "NEW", "pollYear": "2022", "pollMonth": "March", "players": {} };
        }

        // Get the date next Monday
        nextMonday = new Date();
        if ((nextMonday.getDay() == 1) && (nextMonday.getHours() >= 19)) {
          // date is a Monday after kick-off time (6-7pm), so jump forward a day to force the next week
          nextMonday.setDate(nextMonday.getDate() + 1);
          console.log('Currently a Monday after kick-off so adding a day to:' + nextMonday.toISOString());
        }
        nextMonday.setDate(nextMonday.getDate() + (1 + 7 - nextMonday.getDay()) % 7);
        console.log('Next Monday:' + nextMonday.toISOString());

        // combine database data with supplimentary game data
        const gameInfo = '{MayNotBeNeeded:0}';
        //var pageData = JSON.stringify({ gameInfo: gameInfo, data: rowdata });
        var pageData = { gameInfo: gameInfo, data: rowdata, nextMonday: nextMonday.toISOString() };
        res.render('pages/poll-generate-teams', { pageData: pageData} );
        //res.render('pages/poll', { gameInfo: JSON.stringify(gameInfo), data: pageData } );
        client.release();
      } catch (err) {
        console.error(err);
        res.send("Error " + err);
      }
    })
.get('/poll', async (req, res) => {
      try {
        console.log('Rendereing POLL page with data' + req.query.date);
        var requestedDate = new Date();
        if (req.query.date) {
          requestedDate = new Date(req.query.date);
        } else {
          // if date not specified just default to beginning of this month
          requestedDate.setDate(1);
        }
        var requestedDateMonth = requestedDate.toISOString().split('T')[0]
        //console.log("PPP=" + monthDateNumericFormat.format(requestedDate))


const allquery = datastore.createQuery("games");
const [alldbresult] =  await datastore.runQuery(allquery);
console.log('alldbresult=' + JSON.stringify(alldbresult));
    //const [dbresult] = await getGames();
    const query = datastore.createQuery("games").filter('gameid', '=', requestedDateMonth).order('timestamp', {descending: true}).limit(1);
    const [dbresult] =  await datastore.runQuery(query);

//        const client = await pool.connect();
//        const dbresult = await client.query('SELECT * FROM games WHERE gameid=\'' + requestedDateMonth + '\'');
        console.log('dbresult=' + JSON.stringify(dbresult));

        //if (!rowdata) {
        if (dbresult[0]) {
          //if (dbresult.rowCount == 1) {
          //rowdata = dbresult.rows[0];
          rowdata = dbresult[0]
        } else {
          //rowdata = { "status": "NEW", "pollYear": "2022", "pollMonth": "02", "players": {} };
          // create a blank entry to render the poll page
          //rowdata = { "status": "NO_DATABASE_ENTRY", "gameid": requestedDateMonth, "gamedetails":{"players":{}}}
          rowdata = { "status": "NO_DATABASE_ENTRY", "gameid": requestedDateMonth, "players":{}}
        }
        console.log('rowdata=' + JSON.stringify(rowdata));

        // combine database data with supplimentary game data
        const gameInfo = '{MayNotBeNeeded:0}';
        //var pageData = JSON.stringify({ gameInfo: gameInfo, data: rowdata });
        var pageData = { gameInfo: gameInfo, data: rowdata };
        res.render('pages/poll', { pageData: pageData} );
        //res.render('pages/poll', { gameInfo: JSON.stringify(gameInfo), data: pageData } );
//        client.release();
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
    
    gameId = gameYear + "-" + gameMonth + "-01";
    var timestamp = new Date();
    var gamedetails_new = { "gameid": gameId, "timestamp": timestamp, "pollYear": gameYear, "pollMonth": gameMonth, "players": players };
    gamedetailsNewJson = JSON.stringify(gamedetails_new);
    console.log('Inserting DB data:', gamedetailsNewJson);

    try {
      
/**
      ////// TODO Database LOCK?
      const client = await pool.connect();
      const dbresult = await client.query('SELECT * FROM games WHERE gameid=\'' + gameId + '\'');

      if (dbresult.rowCount == 1) {
        rowdata = dbresult.rows[0];
      } else {
        rowdata = { "gamedetails":{"players":{}}}
      }
      var gamedetails_pre = rowdata.gamedetails;
      var gamedetailsPreJson = JSON.stringify(gamedetails_pre);
      console.log('pre1 Pre (DB):', gamedetails_pre);
      console.log('pre2 New:', gamedetails_new);
      // merge the two objects
      const gamedetails_merged = {
        ...gamedetails_pre,
        ...gamedetails_new
      };
      console.log('Post - merged:', gamedetails_merged);
      var gamedetailsDiffJson = JSON.stringify(gamedetails_diff);
      var gamedetailsMergedJson = JSON.stringify(gamedetails_merged);

      var gamedetails_diff = createJsonDiff(gamedetails_pre, gamedetails_new);
      gamedetailsDiffJson = JSON.stringify(gamedetails_diff);
      console.log('Post - Diff:', gamedetails_diff);

      //console.log('IP Addresses:', req.socket.remoteAddress, req.socket.localAddress, req.ip);

      // firstly update the main game table
      const result = await client.query(`INSERT INTO games( gameid, gamedetails)
        VALUES ('${gameId}', '${gamedetailsNewJson}')
        ON CONFLICT (gameid) DO UPDATE 
          SET gamedetails = '${gamedetailsNewJson}';`)
      const results = { 'results': (result) ? result.rows : null};
      console.log('Got DB results2:', results);
      
      // now update the table history table
      const historyresult = await client.query(`INSERT INTO game_history( gameid, gamedetails_pre, 
        gamedetails_new, gamedetails_merged, gamedetails_diff)
        VALUES ('${gameId}', '${gamedetailsPreJson}', 
        '${gamedetailsNewJson}', '${gamedetailsMergedJson}', '${gamedetailsDiffJson}');`)
      const historyresults = { 'historyresults': (historyresult) ? historyresult.rows : null};
      console.log('Got History DB results:', historyresults);
**/

      //datastore.save({ key: gameId, data: gamedetails_new });
      await datastore.save({ key: datastore.key('games'), data: gamedetails_new})

      // if you got here without an exception then everything was successful
      //res.sendStatus(200);
      res.json({'result': 'OK'})
//      client.release();
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


/**
 * Insert a visit record into the database.
 *
 * @param {object} visit The visit record to insert.
 */
const insertVisit = visit => {
  return datastore.save({
    key: datastore.key('visit'),
    data: visit,
  });
};

/**
 * Retrieve the latest 10 visit records from the database.
 */
const getVisits = () => {
  const query = datastore
    .createQuery('visit')
    .order('timestamp', {descending: true})
    .limit(10);

  return datastore.runQuery(query);
};

/**
 * Retrieve the latest 10 games records from the database.
 */
const getGame = gameId => {
  const query = datastore.createQuery(gameId);
  return datastore.runQuery(query);
};
