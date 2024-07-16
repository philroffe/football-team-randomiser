const EMAIL_TYPE_ALL_PLAYERS = 0;
const EMAIL_TYPE_ADMIN_ONLY = 1;
const EMAIL_TYPE_TEAMS_ADMIN = 2;
var SYSTEM_ADMIN_EMAIL_ADDRS = "Phil Roffe <philroffe@gmail.com>";
var TEAMS_ADMIN_EMAIL_ADDRS = SYSTEM_ADMIN_EMAIL_ADDRS;
var ATTENDANCE_ADMIN_EMAIL_ADDRS = TEAMS_ADMIN_EMAIL_ADDRS;
var MAILING_LIST_ADMIN_EMAIL_ADDRS =  SYSTEM_ADMIN_EMAIL_ADDRS;
var ENABLE_TEST_EMAILS =  false;
var transporter;
if (typeof module != "undefined") {
  SYSTEM_ADMIN_EMAIL_ADDRS = (process.env.SYSTEM_ADMIN_EMAIL_ADDRS) ? process.env.SYSTEM_ADMIN_EMAIL_ADDRS : "Phil Roffe <philroffe@gmail.com>";
  TEAMS_ADMIN_EMAIL_ADDRS = (process.env.TEAMS_ADMIN_EMAIL_ADDRS) ? process.env.TEAMS_ADMIN_EMAIL_ADDRS : SYSTEM_ADMIN_EMAIL_ADDRS;
  ATTENDANCE_ADMIN_EMAIL_ADDRS = (process.env.ATTENDANCE_ADMIN_EMAIL_ADDRS) ? process.env.ATTENDANCE_ADMIN_EMAIL_ADDRS : TEAMS_ADMIN_EMAIL_ADDRS;
  MAILING_LIST_ADMIN_EMAIL_ADDRS = (process.env.MAILING_LIST_ADMIN_EMAIL_ADDRS) ? process.env.MAILING_LIST_ADMIN_EMAIL_ADDRS : SYSTEM_ADMIN_EMAIL_ADDRS;
  ENABLE_TEST_EMAILS = (process.env.ENABLE_TEST_EMAILS) ? (process.env.ENABLE_TEST_EMAILS.toUpperCase() === "ENABLED") : false;
  /* Email functionality */
  const nodemailer = require('nodemailer');
  const GOOGLE_MAIL_USERNAME = (process.env.GOOGLE_MAIL_USERNAME) ? process.env.GOOGLE_MAIL_USERNAME : "NOT_SET";
  const GOOGLE_MAIL_APP_PASSWORD = (process.env.GOOGLE_MAIL_APP_PASSWORD) ? process.env.GOOGLE_MAIL_APP_PASSWORD : "NOT_SET";
  var transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GOOGLE_MAIL_USERNAME,
      pass: GOOGLE_MAIL_APP_PASSWORD
    }
  });
}

  function getNextMondayIndex(options, nextMondayDate) {
    var monthDateFormat = new Intl.DateTimeFormat('en', { month: 'short' });
    var monthDateLongFormat = new Intl.DateTimeFormat('en', { month: 'long' });
    var monthDateNumericFormat = new Intl.DateTimeFormat('en', { month: '2-digit' });
    var nextMondayDate = new Date(nextMondayDate);

    // loop throught the options and find the index for next Monday
    var nextMondayOptionIndex = -1
    //optionDates = "Dates"
    Object.keys(options).forEach(function(key) {
      //optionDate = new Date(options[key].date);
      optionDate = new Date(options[key] + " " + monthDateFormat.format(nextMondayDate) + " " + nextMondayDate.getFullYear());
      //optionDateText = dayDateFormat.format(optionDate) + " " + monthDateFormat.format(optionDate);

      if (datesAreOnSameDay(optionDate, nextMondayDate)) {
        //optionDates += " : <b><u>" + optionDateText + " </u></b>"
        // store the index for this Monday - used to get the players
        nextMondayOptionIndex = key
      } else {
        //optionDates += " : " + optionDateText
      }
    });

    if (nextMondayOptionIndex != -1) {
      console.log('Found next Monday option:' + nextMondayOptionIndex);
    } else {
      console.log('No game this upcoming Monday:' + nextMondayDate);
    }
    return nextMondayOptionIndex;
  }

  function datesAreOnSameDay(first, second) {
    return first.getFullYear() === second.getFullYear() &&
      first.getMonth() === second.getMonth() &&
      first.getDate() === second.getDate();
  }

  /**
  * algorithmType - "algorithm[0-5]" - name of the algorithm to sort players by 
  * players - a map of players availability for selection this month
  * playersPreviewData - a map of previously generated redTeam, blueTeam, standby lists (if previously generated)
  * allAttendanceData - A full collection of historical attendance data (to be filtered by noOfPreviousMonths before use by algorith calculation)
  * aliasToPlayerMap - A map of player name aliases to get the official name
  * nextMondayOptionIndex - the index of next Monday's game - used in the players map to get availability
  * noOfPreviousMonths - the number of months of historical attendance data to use to generate the algorithm score
  */
  function changeAlgorithmForPlayers(algorithmType, players, playersPreviewData, allAttendanceData, aliasToPlayerMap, nextMondayOptionIndex
    , noOfPreviousMonths) {
    var playersGamesPlayedRatio = {};

    /////////////////////
    /////////////////////
    /////////////////////
    //var requestedDate = new Date(startDate);
    //maxNoOfMonths = monthDiff(new Date("2023-01-01"), requestedDate);
    //noOfMonths = Math.min(noOfPreviousMonths, maxNoOfMonths);

    // clone the 
    //let allAttendanceData = { ...allAttendanceData }
    var currentCount = 0;
    var filteredAllAttendanceData = {};
    for (const gamesCollectionId in allAttendanceData) {
      if (currentCount <= noOfPreviousMonths) {
        filteredAllAttendanceData[gamesCollectionId] = allAttendanceData[gamesCollectionId];
        //console.log(gamesCollectionId)
        currentCount++;
      }
    }
    allAttendanceData = filteredAllAttendanceData;
    /////////////////////
    /////////////////////
    /////////////////////

    // create list of all players from allAttendanceData
    var allPastPlayers = [];
    Object.keys(allAttendanceData).forEach(function(gamesCollectionId) {
      var weekAttendanceData = allAttendanceData[gamesCollectionId];
      Object.keys(weekAttendanceData).forEach(function(weekNumber) {
        if (weekNumber >= '0' && weekNumber <= '52') {
          var playerList = weekAttendanceData[weekNumber];
          Object.keys(playerList).forEach(function(playerName) {
            if (playerName != "scores") {
              //console.log("FOUND:", playerName, weekNumber, gamesCollectionId);
              if (!allPastPlayers.includes(playerName)) {
                allPastPlayers.push(playerName);
              }
            }
          });
        }
      });
    });
    //playersGamesPlayedRatio.allPastPlayers = allPastPlayers;
    //console.log("allPastPlayers:", allPastPlayers);


    // create list of all players who have ticked this option this week
    //console.log("PLAYERS", players);
    var thisWeekPlayers = [];
    Object.keys(players).forEach(function(key) {
      playerName = key;
      var officialName = aliasToPlayerMap[playerName.toUpperCase()];
      if (!officialName) {
        // new player so use unofficial name and add to player list if needed
        officialName = playerName;
        if (!allPastPlayers.includes(officialName)) {
          allPastPlayers.push(officialName);
        }
      }
      //console.log("ALIAS", playerName, officialName);

      playerCanPlay = players[key][nextMondayOptionIndex];
      if (playerCanPlay) {
        //console.log("officialName:" + officialName + " --- " + playerCanPlay);
        thisWeekPlayers.push(officialName);
      }
    });
    //console.log("thisWeekPlayers", thisWeekPlayers);

    // get total number of games possible
    var totalPossibleGames = 0;
    Object.keys(allAttendanceData).forEach(function(gamesCollectionId) {
      for (var weekNumber = 0; weekNumber < 5; weekNumber ++) {
        if (allAttendanceData[gamesCollectionId][weekNumber] && allAttendanceData[gamesCollectionId][weekNumber]['scores']) {
          totalPossibleGames++;
        }
      }
    });
    //console.log("Total games...", totalPossibleGames);

    // now calculate the ratio for algorithms for all players (past players + any additions this week)
    var allPlayersCombined = [...allPastPlayers];
    for (var i = 0; i < thisWeekPlayers.length; i++) {
      const index = allPastPlayers.indexOf(thisWeekPlayers[i]);
      if (index == -1) {
        allPlayersCombined.push(thisWeekPlayers[i]);
      }
    }
    //console.log("allPlayersCombined", allPlayersCombined);
    Object.values(allPlayersCombined).forEach(function(currentPlayer) {
      //console.log("XXX", currentPlayer)
      playersGamesPlayedRatio[currentPlayer] = {'algorithm4':0, 'won':0, 'lost':0, 'drawn':0
      , 'goalsScored':0, 'didnotplay':0, 'thisWeekPlayer': false};
      
      // loop through all of the attendance data, lookup current player
      Object.keys(allAttendanceData).forEach(function(gamesCollectionId) {
        var weekAttendanceData = allAttendanceData[gamesCollectionId];
        //console.log("Calculating month data...", gamesCollectionId, weekAttendanceData);
        
        // get all players for the month
        for (var weekNumber = 0; weekNumber < 5; weekNumber ++) {
          if (weekAttendanceData[weekNumber]) {
            var weekScores = weekAttendanceData[weekNumber]['scores'];
            if (weekScores) {
              // attendance data includes the scores so check if the currentPlayer played
              var playerWeekTeamNumber = weekAttendanceData[weekNumber][currentPlayer];
              //console.log("using player week data...", currentPlayer, playerWeekTeamNumber);
              if (playerWeekTeamNumber) {
                // played
                var goalsFor = weekScores['team' + playerWeekTeamNumber + 'goals'];
                var oppositeTeamNumber = (playerWeekTeamNumber == 1) ? 2 : 1;
                var goalsAgainst = weekScores['team' + oppositeTeamNumber + 'goals'];
                //console.log("TEAM", playerWeekTeamNumber, oppositeTeamNumber);

                if (weekScores['winner'] == playerWeekTeamNumber) {
                  //console.log("PLAYED, WON", currentPlayer, goalsFor, goalsAgainst);
                  playersGamesPlayedRatio[currentPlayer].won += 1;
                  playersGamesPlayedRatio[currentPlayer].algorithm4 += 5;
                } else if (weekScores['winner'] == 0) {
                  //console.log("PLAYED, DRAW", currentPlayer, goalsFor, goalsAgainst);
                  playersGamesPlayedRatio[currentPlayer].drawn += 1;
                  playersGamesPlayedRatio[currentPlayer].algorithm4 += 3;
                } else {
                  //console.log("PLAYED, LOST", currentPlayer, goalsFor, goalsAgainst);
                  playersGamesPlayedRatio[currentPlayer].lost += 1;
                  playersGamesPlayedRatio[currentPlayer].algorithm4 += 1;
                }

                // now get the number of goals scored
                var goalsScorers = weekScores['team' + playerWeekTeamNumber + 'scorers'];
                if (goalsScorers && goalsScorers[currentPlayer]) {
                  playersGamesPlayedRatio[currentPlayer].goalsScored += goalsScorers[currentPlayer];
                }
              } else {
                // did not play
                //console.log("DID NOT PLAY", currentPlayer);
                playersGamesPlayedRatio[currentPlayer].didnotplay = playersGamesPlayedRatio[currentPlayer].didnotplay + 1;
              }
            }
          }
        }
      });

      // first check if this player is available to play this week
      if (thisWeekPlayers.includes(currentPlayer)) {
        playersGamesPlayedRatio[currentPlayer].thisWeekPlayer = true;
      } else {
        playersGamesPlayedRatio[currentPlayer].thisWeekPlayer = false;
      }
    });

    
    // now calculate the ratio for algorithms
    Object.keys(playersGamesPlayedRatio).forEach(function(playerName) {
      //console.log(playerName);
      var playerStats = playersGamesPlayedRatio[playerName];
      var totalGamesPlayed = playerStats.won + playerStats.lost + playerStats.drawn;

      if (totalGamesPlayed > 5) {
        // algorithm0 = everyone equally weighted
        playersGamesPlayedRatio[playerName].algorithm0ratio = Math.random().toFixed(3);

        // algorithm1 = win ratio
        playersGamesPlayedRatio[playerName].algorithm1ratio = (playerStats.won / totalGamesPlayed).toFixed(2);

        // algorithm2 = win+draw ratio
        playersGamesPlayedRatio[playerName].algorithm2ratio = ((playerStats.won + playerStats.drawn) / totalGamesPlayed).toFixed(2);

        // algorithm3 = average generated score per game (5 for win, 3 for draw, 1 for loss, 0 for not-played)
        playersGamesPlayedRatio[playerName].algorithm3ratio = (playerStats.algorithm4 / totalGamesPlayed).toFixed(2);

        // algorithm4 = total generated score per game (5 for win, 3 for draw, 1 for loss, 0 for not-played)
        playersGamesPlayedRatio[playerName].algorithm4ratio = playerStats.algorithm4.toFixed(2);

        // algorithm5 = most played
        playersGamesPlayedRatio[playerName].algorithm5ratio = totalGamesPlayed;

        // algorithm6 = goals scored per game
        playersGamesPlayedRatio[playerName].algorithm6ratio = (playerStats.goalsScored / totalGamesPlayed).toFixed(2);

        // algorithm6 = sort by algorithm3 and pick teams by alternating between the top 3 and the bottom 3

        // algorithm7 = sort by algorithm (1, 2, 3 or 4) and pick teams by randomising the top 3 and the bottom 3
      } else {
        // new player so defeult to rank as 50/50
        playersGamesPlayedRatio[playerName].algorithm0ratio = 0.5;
        playersGamesPlayedRatio[playerName].algorithm1ratio = 0.5;
        playersGamesPlayedRatio[playerName].algorithm2ratio = 0.5;
        playersGamesPlayedRatio[playerName].algorithm3ratio = 0.5;
        playersGamesPlayedRatio[playerName].algorithm4ratio = 2;
        playersGamesPlayedRatio[playerName].algorithm5ratio = 0;
        playersGamesPlayedRatio[playerName].algorithm6ratio = 0;
      }
    });

    // create sorted array from the algorithm selected
    let sortedPlayers = [];
    for (var ratios in playersGamesPlayedRatio) {
      sortedPlayers.push([ratios, playersGamesPlayedRatio[ratios]]);
    }
    sortedPlayers.sort(function(a, b) {
      return b[1][algorithmType + "ratio"] - a[1][algorithmType + "ratio"];
    });
    //console.log("SORTED PLAYERS:", sortedPlayers);
    // recreate the object
    let sortedPlayerNamesThisWeek = [];
    sortedPlayers.forEach(function(playerName){
      if (playersGamesPlayedRatio[playerName[0]] && playersGamesPlayedRatio[playerName[0]].thisWeekPlayer) {
        sortedPlayerNamesThisWeek.push(playerName[0]);
      }
    })
    //console.log("SORTED PLAYERS THIS WEEK:", sortedPlayerNamesThisWeek);

    /////////////////////////////////////////////
    /////////////////////////////////////////////
    /////////////////////////////////////////////
    var forceUpdate = false;
    if (playersPreviewData) {
      var tmpAllPlayersThisWeek = [...sortedPlayerNamesThisWeek];
      var tmpPreviewPlayersThisWeek = playersPreviewData.redPlayers.concat(playersPreviewData.bluePlayers, playersPreviewData.standbyPlayers);
      var playersRemovedFromPreview = [];

      for (var i = 0; i < tmpPreviewPlayersThisWeek.length; i++) {
        const index = tmpAllPlayersThisWeek.indexOf(tmpPreviewPlayersThisWeek[i]);
        if (index > -1) {
          // remove player from full list
          tmpAllPlayersThisWeek.splice(index, 1);
        } else {
          // player removed so need to regenerate teams
          playersRemovedFromPreview.push(tmpPreviewPlayersThisWeek[i]);
        }
      }
      if (tmpAllPlayersThisWeek.length > 0 || playersRemovedFromPreview.length > 0) {
        // player change so force update
        playersPreviewData.redPlayers = [];
        playersPreviewData.bluePlayers = [];
        forceUpdate = true;
      }
      playersGamesPlayedRatio.generatedTeams = playersPreviewData;
    } else {
      // not yet generated so initialise it set force update
      playersPreviewData = {};
      playersPreviewData.standbyPlayers = [];
      forceUpdate = true;
    }
    /////////////////////////////////////////////
    /////////////////////////////////////////////
    /////////////////////////////////////////////

    if (forceUpdate) {
      // generate the teams - standby first, then divide into reds and blues
      var standbyPlayers = generateStandbyPlayers(sortedPlayers, sortedPlayerNamesThisWeek, playersPreviewData.standbyPlayers);
      var generatedTeams = generateRedBlueTeams(sortedPlayerNamesThisWeek, standbyPlayers);
      //console.log("NEW TEAMS", generatedTeams)
      playersGamesPlayedRatio.standbyPlayers = standbyPlayers;
      playersGamesPlayedRatio.generatedTeams = generatedTeams;
    }
    
    playersGamesPlayedRatio.sortedPlayers = sortedPlayers;
    playersGamesPlayedRatio.totalPossibleGames = totalPossibleGames;
    return playersGamesPlayedRatio;
  }

function generateStandbyPlayers(sortedPlayers, sortedPlayerNamesThisWeek, forcePlayersOnStandby) {
    var standbyPlayers = [];
    var numberStandbyNeeded = 0;
    if (sortedPlayerNamesThisWeek.length >= 12) {
      numberStandbyNeeded = sortedPlayerNamesThisWeek.length - 12;
    } else {
      numberStandbyNeeded = sortedPlayerNamesThisWeek.length - 10;
    }
    if (numberStandbyNeeded > 0) {
      // we have standby players
      var sortedPlayersByGamesPlayed = [...sortedPlayers];
      sortedPlayersByGamesPlayed.sort(function(a, b) {
        return b[1].algorithm5ratio - a[1].algorithm5ratio;
      });
      sortedPlayersByGamesPlayed = sortedPlayersByGamesPlayed.reverse();

      // filter players playing this week
      var randomStandbyOptions = [];
      for (var i = 0; i < sortedPlayersByGamesPlayed.length; i++) {
        var standbyPlayerName = sortedPlayersByGamesPlayed[i][0];
        if (sortedPlayerNamesThisWeek.includes(standbyPlayerName)) {
          randomStandbyOptions.push(standbyPlayerName);
        }
      }

      console.log("CHECK standby:", forcePlayersOnStandby);

      // allocate the forcePlayersOnStandby first
      if (forcePlayersOnStandby && forcePlayersOnStandby.length > 0 && numberStandbyNeeded > 0) {
        for (var i = 0; i < numberStandbyNeeded; i++) {
          if (forcePlayersOnStandby.length > i) {
            const index = randomStandbyOptions.indexOf(forcePlayersOnStandby[i]);
            if (index > -1) {
              // forced-standby player exists so add to standby and remove from main sorted list
              console.log("Added to forced standby:", forcePlayersOnStandby[i]);
              standbyPlayers.push(forcePlayersOnStandby[i]);
              numberStandbyNeeded--;
              //randomStandbyOptions.splice(index, 1);
            }
          }
        }
      }

      // take half(ish) of the ordered list
      randomStandbyOptions = randomStandbyOptions.slice(0, Math.floor(randomStandbyOptions.length/2) - 2);
      // randomise the list
      randomStandbyOptions = shuffle(randomStandbyOptions);
      //console.log("RANDOMISED STANDBY OPTIONS", randomStandbyOptions);

      for (var i = 0; i < numberStandbyNeeded; i++) {
        // add player to standby
        var standbyPlayerName = randomStandbyOptions[i];
        //console.log("ADDING STANDBY:", standbyPlayerName);
        standbyPlayers.push(standbyPlayerName);
      }
    }
    return standbyPlayers;
  }

  function generateRedBlueTeams(playersList, optionalStandbyPlayers = []) {
    var redPlayers = [];
    var bluePlayers = [];
    var standbyPlayers = optionalStandbyPlayers;

    var playerCount = playersList.length;
    var maxPlayersPerTeam = Math.floor(playerCount/2) + 1;
    for (var i = 0; i < playerCount; i++) {
      var totalPlayerCount = redPlayers.length + bluePlayers.length;
      if (!standbyPlayers.includes(playersList[i])) {
        if (totalPlayerCount < 12) {
          // evens on reds, odds on blues
          if (totalPlayerCount%2 == 0) {
            if (redPlayers.length < maxPlayersPerTeam) {
              redPlayers.push(playersList[i]);
            } else {
              standbyPlayers.push(playersList[i]);
              console.log("REDS", i, redPlayers.length, maxPlayersPerTeam);
            }
          } else {
            if (bluePlayers.length < maxPlayersPerTeam) {
              bluePlayers.push(playersList[i]);
            } else {
              standbyPlayers.push(playersList[i]);
              console.log("BLUES", i, redPlayers.length, maxPlayersPerTeam);
            }
          }
        } else {
          standbyPlayers.push(playersList[i]);
          console.log("PLAY", i, redPlayers.length, maxPlayersPerTeam);
        }
      }
    }

    // console.log("Generated Teams:", generatedTeams);
    var generatedTeams = {'redPlayers': redPlayers, 'bluePlayers': bluePlayers, 'standbyPlayers':standbyPlayers}
    return generatedTeams;
  }
  
  // no longer used, but this was the original randomiser
  function shuffle(array) {
    var currentIndex = array.length,  randomIndex;

    // While there remain elements to shuffle...
    while (currentIndex != 0) {
      // Pick a remaining element...
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex--;
      // And swap it with the current element.
      [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex]];
    }

    return array;
  }

function generateTeamsEmailText(generatedTeams, nextMondayDate) {
  //console.log("GENERATING TEAMS...", generatedTeams)
  var redPlayers = generatedTeams.redPlayers
  var bluePlayers = generatedTeams.bluePlayers
  var standbyPlayers = generatedTeams.standbyPlayers
  //////////////////////
  // generate email text
  //////////////////////

  var monthDateFormat = new Intl.DateTimeFormat('en', { month: 'short' });
  var monthDateLongFormat = new Intl.DateTimeFormat('en', { month: 'long' });
  var monthDateNumericFormat = new Intl.DateTimeFormat('en', { month: '2-digit' });
  var dayDateFormat = new Intl.DateTimeFormat('en', { day: '2-digit' });
  var pollLink = "https://tensile-spirit-360708.nw.r.appspot.com/poll";

  var emailHeader = ""
  var emailSubject = ""
  //var playerCount = playersList.length;
  var playerCount = generatedTeams.redPlayers.length + generatedTeams.bluePlayers.length + generatedTeams.standbyPlayers.length;
  if (playerCount == 0) {
    emailHeader = "Only " + playerCount + " players this week - any more or should I cancel?"
    emailSubject = "NO PLAYERS FOUND - CHECK DATE AND POLL IS CORRECT: "
  } else if (playerCount <= 6) {
    emailHeader = "Only " + playerCount + " players this week - any more or should I cancel?"
    emailSubject = "LOTS of Players Needed"
  } else if (playerCount == 7) {
    emailHeader = "Only " + playerCount + " players so far - 3 needed.\nAnyone?"
    emailSubject = "3 Players Needed"
  } else if (playerCount == 8) {
    emailHeader = "Only " + playerCount + " players so far so 4-a-side as it stands. 2 players needed to make 10.\nAnyone fancy a game?"
    emailSubject = "2 Players Needed"
  } else if (playerCount == 9) {
    emailHeader = playerCount + " players so far this week - 1 needed to make it an even 5-a-side.\nAnyone fancy a game?"
    emailSubject = "1 Players Needed"
  } else if (playerCount == 10) {
    emailHeader = playerCount + " players this week so 5-a-side and game on."
    emailSubject = "Teams"
  } else if (playerCount == 11) {
    emailHeader = playerCount + " players this week - so 5-a-side with 1 on standby (see below), or 1 needed to make it 6-a-side.\nAnyone fancy a game?"
    emailSubject = "Teams"
  } else if (playerCount == 12) {
    emailHeader = playerCount + " players this week, so 6-a-side and game on."
    emailSubject = "Teams"
  } else if (playerCount > 12) {
    emailHeader = playerCount + " players this week, so 6-a-side with some on standby - see names below."
    emailSubject = "Teams"
  }

  fullEmailSubject = emailSubject + " - Mon " + dayDateFormat.format(nextMondayDate) + " " + monthDateFormat.format(nextMondayDate) + " [Footie, Goodwin, 6pm Mondays]\n"
  fullEmailText = "Hi all,\n\n" + emailHeader + "\n\nTeams below...\n\n"

  fullEmailText += "REDS\n"
  for (var i = 0; i < redPlayers.length; i++) {
    fullEmailText += i+1 + " " + redPlayers[i] + "\n"
  }
  fullEmailText += "\n"
  fullEmailText += "BLUES\n"
  for (var i = 0; i < bluePlayers.length; i++) {
    fullEmailText += i+1 + " " + bluePlayers[i] + "\n"
  }
  if (standbyPlayers.length > 0) {
    fullEmailText += "\n"
    fullEmailText += "STANDBY\n"
    for (var i = 0; i < standbyPlayers.length; i++) {
      fullEmailText += i+1 + " " + standbyPlayers[i] + "\n"
    }
  }
  fullEmailText += "\nCheers,\nPhil\n"
  fullEmailText += "\nMobile: 07960951917\n"
  fullEmailText += pollLink + "\n"
  
  fullEmailText += "\n-----------\n"
  fullEmailText += "To unsubscribe: https://tensile-spirit-360708.nw.r.appspot.com/mailing-list?type=unsubscribe\n"

  var emailDetails = {"emailSubject": fullEmailSubject, "emailBody": fullEmailText};
  return emailDetails;
}

//parse inbound paypal email and extract the relevant data
function parsePaypalEmail(bodyText) {
  //console.log("bodyText email:", bodyText);
  // now loop through and extract the relevant text
  var payeeName;
  var amountFromPayee;
  var transactionId;
  var transactionDate;
  var amount;
  // replace any tabs with newlines and loop through each line
  bodyTextArray = bodyText.replace(/\t/g,'\n').split('\n');
  for (i=0; i<bodyTextArray.length; i++) {
    var thisString = bodyTextArray[i].trim();
    if (thisString) {
      var payeeNameMatch = thisString.match(/(.*)( has sent you)(.*)/);
      //console.log("Line:", payeeNameMatch)
      if (payeeNameMatch) {
        payeeName = payeeNameMatch[1];
        // sometimes can get the amount here too, but paypal is inconsistent so storing it but not using it
        amountFromPayee = Number(payeeNameMatch[3].replace(/[^0-9.]/g, ''));
      } else if (thisString.match(/Transaction ID/)) {
        // get value of next line
        transactionId = bodyTextArray[i+1].trim();
      } else if (thisString.match("date")) {
        // get value of next line
        transactionDate = new Date(bodyTextArray[i+1].trim());
      } else if (thisString.match("GBP")) {
        // get only the numbers in the string
        amount = Number(thisString.replace(/[^0-9.]/g, ''));
      }
    }
  }
  var parsedData = { "payeeName": payeeName, "amountFromPayee": amountFromPayee, "transactionId": transactionId, "transactionDate": transactionDate, "amount": amount};
  //console.log("Parsed paypal email:", parsedData);
  return parsedData;
}

//parse inbound paypal email and extract the relevant data
function parsePitchEmail(bodyText) {
  //console.log("bodyText email:", bodyText);
  // now loop through and extract the relevant text
  var payeeName;
  var transactionId;
  var transactionDate;
  var receiptNo;
  var orders = {};
  // replace any tabs with newlines and loop through each line
  bodyTextArray = bodyText.replace(/\t/g,'\n').split('\n');
  for (i=0; i<bodyTextArray.length; i++) {
    var thisString = bodyTextArray[i].trim();
    if (thisString) {
      //console.log("Line:", thisString)
      payeeName = "Admin";
      if (thisString.match(/Payment Date: /)) {
        transactionDate = thisString.replace(/Payment Date: /g, '');
      } else if (thisString.match(/Your Order Number is /)) {
        transactionId = thisString.replace(/Your Order Number is /g, '');
      } else if (thisString.match(/The University receipt number for this transaction is /)) {
        receiptNo = thisString.replace(/The University receipt number for this transaction is /g, '');
      } else if (thisString.match("John Hawley Bb")) {
        var orderDate = thisString.replace(/John Hawley Bb \(/g, '').replace(/\)/g, '');
        var orderAmount = bodyTextArray[i+1].trim().replace(/Amount NET: /g, '').replace(/\(.*/g, '');
        orders[orderDate] = Number(orderAmount.replace(/Amount NET: /g, ''));
        bodyTextArray[i+1].trim();
        transactionDate = new Date(bodyTextArray[i+1].trim());
      }
    }
  }
  var parsedDataMap = [];
  var allPayeeNames = "";
  var allAmounts = "";
  var allGameDates = "";
  var allTransationIds = "";
  var allTransationDates = "";
  for (const orderDate in orders) {
    var parsedData = { "payeeName": payeeName, "amount": orders[orderDate], "gameDate": orderDate,
    "transactionId": transactionId, "transactionDate": orderDate};
    parsedDataMap.push(parsedData);

    allPayeeNames += "," + payeeName;
    allAmounts += "," + orders[orderDate];
    allGameDates += "," + orderDate;
    allTransationIds += "," + transactionId;
    allTransationDates += "," + orderDate;

  }
  var parsedData = { "payeeName": payeeName, "amount": orders[orderDate], "gameDate": orderDate,
    "transactionId": transactionId, "transactionDate": orderDate};

  console.log("Parsed paypal email:", parsedDataMap);
  return parsedData;
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


function mondaysInMonth(m,y) {
  var lastDateOfMonth = new Date(y,m,0).getDate();
  var firstDayNumberOfMonth =  new Date(m +'/01/'+ y).getDay(); // 0=Sun, 1=Mon...

  // check what day the 1st of the month is, and then calc the date of the next Monday
  var mondayDate;
  if (firstDayNumberOfMonth == 1) {
    // already a Monday (1st of the month)
    mondayDate = 1;
  } else if (firstDayNumberOfMonth == 0) {
    // it's a Sunday, so Monday is 1 day away (2nd of the month)
    mondayDate = 2;
  } else {
    // must be Tues-Sat so subtract from 9 (because max 7 days from )
    var mondayDate = 7 - (firstDayNumberOfMonth - 2);
  }

  // now loop through every 7 days and form an array of Monday dates
  var mondays = [];
  for (var i = mondayDate; i <= lastDateOfMonth; i += 7) {
    mondays.push(i);
  }

  console.log("First Monday of month:", new Date(m +'/0' + mondays[0] + '/'+ y));
  //console.log("Mondays in the month:", mondays);
  return mondays;
}


function checkIfBankHoliday(bankHolidaysJson, pollDate) {
  // check whether a bank holiday
  var isBankHoliday = false;

  Object.keys(bankHolidaysJson).forEach(function(key) {
    if (key == "england-and-wales") {
      for (var j = 0; j < bankHolidaysJson[key].events.length; j++) {
        var bankHolDate = new Date(bankHolidaysJson[key].events[j].date);
        if (bankHolDate.toISOString().split('T')[0] == pollDate.toISOString().split('T')[0]) {
          isBankHoliday = true;
        }
      }
    }
  });
  return isBankHoliday;
}

// send an email to the admins to notify of certain events (such as a player availability change)
// type determines list of people in the TO address - see EMAIL_TYPE_* constants
function sendAdminEvent(type, title, details) {
  var emailTo = SYSTEM_ADMIN_EMAIL_ADDRS;
  switch (type) {
    case EMAIL_TYPE_ADMIN_ONLY:
      emailTo = SYSTEM_ADMIN_EMAIL_ADDRS;
      break;
    case EMAIL_TYPE_TEAMS_ADMIN:
      emailTo = TEAMS_ADMIN_EMAIL_ADDRS; 
      break;
    default:
      console.log('WARN - Skipping sending admin email:' + title + ' Unknown admin event type:' + type);
      return;
  }

  var mailOptions = {
    from: SYSTEM_ADMIN_EMAIL_ADDRS,
    to: emailTo,
    subject: title,
    html: "<pre>" + details + "</pre>"
  };

  // if a test env, check whether to send and update to/from accordingly
  if (process.env.ENVIRONMENT != "PRODUCTION") {
    if (ENABLE_TEST_EMAILS) {
      // if localhost then force testing emails only
      mailOptions.to = [SYSTEM_ADMIN_EMAIL_ADDRS];
      mailOptions.from = [SYSTEM_ADMIN_EMAIL_ADDRS];
      console.log('FORCING SENDING _TEST_ ADMIN MSG BECAUSE RUNNING LOCALLY');
    } else {
      console.log('EMAIL-LOG - test env so not sending admin email: ', mailOptions);
      return;
    }
  }

  // now send the email
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
  // if a test env, check whether to send and update to/from accordingly
  if (process.env.ENVIRONMENT != "PRODUCTION") {
    if (ENABLE_TEST_EMAILS) {
      // if localhost then force testing emails only
      mailOptions.to = [SYSTEM_ADMIN_EMAIL_ADDRS];
      mailOptions.from = [SYSTEM_ADMIN_EMAIL_ADDRS];
      console.log('FORCING SENDING _TEST_ ADMIN MSG BECAUSE RUNNING LOCALLY');
    } else {
      console.log('EMAIL-LOG - test env so not sending admin email: ', mailOptions);
      return;
    }
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

// workaround check as this file is included serverside as a module
if (typeof module != "undefined") {
  module.exports = {
    getNextMondayIndex,
    changeAlgorithmForPlayers,
    generateTeamsEmailText,
    getOfficialNameFromAlias,
    mondaysInMonth,
    datesAreOnSameDay,
    checkIfBankHoliday,
    sendAdminEvent,
    sendEmailToList
  };
}

