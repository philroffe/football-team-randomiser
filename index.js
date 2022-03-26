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

        const client = await pool.connect();
        const dbresult = await client.query('SELECT * FROM games WHERE gameid=\'' + requestedDateMonth + '\'');
        //console.log('dbresult=' + JSON.stringify(dbresult));

        //if (!rowdata) {
        if (dbresult.rowCount == 1) {
          rowdata = dbresult.rows[0];
        } else {
          //rowdata = { "status": "NEW", "pollYear": "2022", "pollMonth": "02", "players": {} };
          // create a blank entry to render the poll page
          rowdata = { "status": "NO_DATABASE_ENTRY", "gameid": requestedDateMonth, "gamedetails":{"players":{}}}
        }
        console.log('rowdata=' + JSON.stringify(rowdata));

        // combine database data with supplimentary game data
        const gameInfo = '{MayNotBeNeeded:0}';
        //var pageData = JSON.stringify({ gameInfo: gameInfo, data: rowdata });
        var pageData = { gameInfo: gameInfo, data: rowdata };
        res.render('pages/poll', { pageData: pageData} );
        //res.render('pages/poll', { gameInfo: JSON.stringify(gameInfo), data: pageData } );
        client.release();
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
    var gamedetails = { "pollYear": gameYear, "pollMonth": gameMonth, "players": players };
    gamedetailsJson = JSON.stringify(gamedetails);
    console.log('Inserting DB data:', gamedetailsJson);

    try {
      const client = await pool.connect();
      //const client = pool.connect();
      const result = await client.query(`INSERT INTO games( gameid, gamedetails)
        VALUES ('${gameId}', '${gamedetailsJson}')
        ON CONFLICT (gameid) DO UPDATE 
          SET gamedetails = '${gamedetailsJson}';`)
      const results = { 'results': (result) ? result.rows : null};
      console.log('Got DB results2:', results);
      //res.sendStatus(200);
      res.json({'result': 'OK'})
      client.release();      
    } catch (err) {
      console.error(err);
      res.send("Error " + err);
    }
  })
.listen(PORT, () => console.log(`Listening on ${ PORT }`))
