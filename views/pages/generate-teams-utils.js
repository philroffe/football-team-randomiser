  function getNextMondayIndex(options, nextMondayDate) {
    var monthDateFormat = new Intl.DateTimeFormat('en', { month: 'short' });
    var monthDateLongFormat = new Intl.DateTimeFormat('en', { month: 'long' });
    var monthDateNumericFormat = new Intl.DateTimeFormat('en', { month: '2-digit' });
    var todayDate = new Date();

    // loop throught the options and find the index for next Monday
    var nextMondayOptionIndex = -1
    //optionDates = "Dates"
    Object.keys(options).forEach(function(key) {
      //optionDate = new Date(options[key].date);
      // Generate a 
      optionDate = new Date(options[key] + " " + monthDateFormat.format(todayDate) + " " + todayDate.getFullYear());
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

  function changeAlgorithmForPlayers(algorithmType, players, allAttendanceData, aliasToPlayerMap, nextMondayOptionIndex) {
    var playersGamesPlayedRatio = {};

    // create list of all players from allAttendanceData
    var allPlayers = [];
    Object.keys(allAttendanceData).forEach(function(gamesCollectionId) {
      var weekAttendanceData = allAttendanceData[gamesCollectionId];
      Object.keys(weekAttendanceData).forEach(function(weekNumber) {
        if (weekNumber >= '0' && weekNumber <= '52') {
          var playerList = weekAttendanceData[weekNumber];
          Object.keys(playerList).forEach(function(playerName) {
            if (playerName != "scores") {
              //console.log("FOUND:", playerName, weekNumber, gamesCollectionId);
              if (!allPlayers.includes(playerName)) {
                allPlayers.push(playerName);
              }
            }
          });
        }
      });
    });
    //playersGamesPlayedRatio.allPlayers = allPlayers;


    // create list of all players who have ticked this option this week
    console.log("PLAYERS", players);
    var thisWeekPlayers = [];
    Object.keys(players).forEach(function(key) {
      playerName = key;
      var officialName = aliasToPlayerMap[playerName.toUpperCase()];
      if (!officialName) {
        // new player so use unofficial name and add to player list if needed
        officialName = playerName;
        if (!allPlayers.includes(officialName)) {
          allPlayers.push(officialName);
        }
      }
      //console.log("ALIAS", playerName, officialName);

      playerCanPlay = players[key][nextMondayOptionIndex];
      if (playerCanPlay) {
        //console.log("officialName:" + officialName + " --- " + playerCanPlay);
        thisWeekPlayers.push(officialName);
      }
    });

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

    // now calculate the ratio for algorithms
    Object.values(allPlayers).forEach(function(currentPlayer) {
      //console.log("XXX", currentPlayer)
      playersGamesPlayedRatio[currentPlayer] = {'algorithm4':0, 'won':0, 'lost':0, 'drawn':0, 'didnotplay':0, 'thisWeekPlayer': false};
      
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

    // generate the teams - standby first, then divide into reds and blues
    var standbyPlayers = generateStandbyPlayers(sortedPlayers, sortedPlayerNamesThisWeek);
    var generatedTeams = generateRedBlueTeams(sortedPlayerNamesThisWeek, standbyPlayers);
    //console.log("NEW TEAMS", generatedTeams)
    
    playersGamesPlayedRatio.sortedPlayers = sortedPlayers;
    playersGamesPlayedRatio.standbyPlayers = standbyPlayers;
    playersGamesPlayedRatio.generatedTeams = generatedTeams;
    playersGamesPlayedRatio.totalPossibleGames = totalPossibleGames;

    return playersGamesPlayedRatio;
  }

function generateStandbyPlayers(sortedPlayers, sortedPlayerNamesThisWeek) {
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

  var emailDetails = {"emailSubject": fullEmailSubject, "emailBody": fullEmailText};
  return emailDetails;
}

//parse inbound paypal email and extract the relevant data
function parsePaypalEmail(bodyText) {
  console.log("bodyText email:", bodyText);
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
  console.log("Parsed paypal email:", parsedData);
  return parsedData;
}

//module.exports = { getNextMondayIndex, datesAreOnSameDay, changeAlgorithmForPlayers, generateStandbyPlayers, generateRedBlueTeams, shuffle, generateTeamsEmailText};