const express = require('express')
const path = require('path')
const PORT = process.env.PORT || 5000
const https = require('https')
const ical = require('node-ical');
const request = require('request');

// store a cache of the data for X seconds
// useful to allow a quick refresh of the screen to randomise players
var icalCache;
var doodlePlayersDataCache;
var cacheLastRefresh = new Date();
var maxCacheSecs = 60;
var nextMonday = new Date();

// URL of the ical from doodle (which can be used to get the link for a given date)
var doodleICalURL = "https://doodle.com/ics/mydoodle/crpabaivl67ttpj2ajnviovmp061axsr.ics"

express()
.use(express.static(path.join(__dirname, 'public')))
.set('views', path.join(__dirname, 'views'))
.set('view engine', 'ejs')
.get('/', (req, res) => res.render('pages/index'))
.get('/doodle', async (req, res) => {
    // Check if cache needs clearing
    var diffSeconds = (new Date().getTime() - cacheLastRefresh.getTime()) / 1000;
    if (diffSeconds > maxCacheSecs) {
      icalCache = undefined
      doodlePlayersDataCache = undefined
      console.log('CLEARED CACHE as diffSeconds was:' + diffSeconds);
    }

    // get the ical, lookup doodle ID for next Monday, download the players
    if (icalCache == undefined || doodlePlayersDataCache == undefined) {
      // download the ical link
      icalCache = await downloadPage(doodleICalURL)
      //console.log('iCalCache: ' + icalCache);

      // Get the date next Monday
      nextMonday = new Date();
      if ((nextMonday.getDay() == 1) && (nextMonday.getHours() >= 19)) {
        // date is a Monday after kick-off time (6-7pm), so jump forward a day to force the next week
        nextMonday.setDate(nextMonday.getDate() + 1);
        console.log('Currently a Monday after kick-off so adding a day to:' + nextMonday.toISOString());
      }
      nextMonday.setDate(nextMonday.getDate() + (1 + 7 - nextMonday.getDay()) % 7);
      console.log('Next Monday:' + nextMonday.toISOString());

      // get the relevant doodle poll URL for next Monday from the ical
      var doodleApiUrl = await getDoodlePollLinkFromICal(icalCache, nextMonday);
      if (doodleApiUrl == undefined) {
        // game not found, so try the week after (caters for Bank holidays etc)
        nextMonday.setDate(nextMonday.getDate() + 7);
        console.log('Next Monday not found.  Trying the one after: ' + nextMonday.toISOString());
        doodleApiUrl = await getDoodlePollLinkFromICal(icalCache, nextMonday);
      }
      console.log('Found doodleApiUrl: ' + doodleApiUrl);
      
      if (doodleApiUrl) {
        // download poll data from API e.g. https://doodle.com/api/v2.0/polls/v7w3a25wsavxiicq
        doodlePlayersDataCache = await downloadPage(doodleApiUrl)
        // Cache the data for one min 
        cacheLastRefresh = new Date();
        console.log('Got iCal and Players data: FROM_NEW_DATA');
      } else {
        console.log('No doodle link found for Monday (Is it Bank Holiday?): ' + nextMonday.toISOString());
      }
    } else {
      console.log('Got iCal and Players data: FROM_CACHE');
    }

    // render the page from the player data
    try {
      console.log('RENDERING PAGE with data');
      if (doodlePlayersDataCache) {
        doodleTeams = JSON.parse(doodlePlayersDataCache);
        doodleTeams.nextMonday = nextMonday.toISOString();
        res.render('pages/doodle-get-teams', doodleTeams);
      } else {
        res.render('pages/no-game');
      }
    } catch (err) {
      console.error(err);
      res.send("Error " + err);
    }

  })
.listen(PORT, () => console.log(`Listening on ${ PORT }`))


// wrap a request in an promise
function downloadPage(url) {
  return new Promise((resolve, reject) => {
    request(url, (error, response, body) => {
      if (error) reject(error);
      if (response.statusCode != 200) {
        reject('Invalid status code <' + response.statusCode + '>');
      }
      resolve(body);
    });
  });
}

function getDoodlePollLinkFromICal(icalData, nextMonday) {
  const events = ical.parseICS(icalData);
  var doodleApiUrl;
  var lastDoodleApiUrl;
  // loop through events and log them
  for (const event of Object.values(events)) {
    ///console.log('Event: ' + event.start);
    if (datesAreOnSameDay(event.start, nextMonday)) {
      // get the doodle poll ID stored at the end of the description
      doodlePollId = event.description.split("/").pop();
      doodleApiUrl = 'https://doodle.com/api/v2.0/polls/' + doodlePollId
      return doodleApiUrl
    } else {
      // sometimes the doodle ical isn't accurate
      // so store the last url found in case we need to drop back to it
      lastDoodlePollId = event.description.split("/").pop();
      lastDoodleApiUrl = 'https://doodle.com/api/v2.0/polls/' + lastDoodlePollId
      lastDoodleApiUrl = undefined
    }
  };
  // ideally we'll never get here.  But if we do, then return the last url found
  console.log('Got doodle URL: ' + doodleApiUrl);
  return lastDoodleApiUrl;
}

function datesAreOnSameDay(first, second) {
  return first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate();
}
