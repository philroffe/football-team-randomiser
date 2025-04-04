const { Builder, By, Key, until } = require('selenium-webdriver')
const chrome = require('selenium-webdriver/chrome')
//const EC = require('wdio-wait-for');
const { querySelector } = require('./helpers')
const indexDBUtils = require('./index-database-utils');

// See Jest docs here: 
// https://jestjs.io/docs/expect
var enabledTests = true;
var enabledHistoricTests = true;
var deleteDataBeforeTests = true;
var deleteDataAfterTests = false;

let driver;
const testYearMonth = "2050-01";
const test2YearMonth = "2050-02";
const rootURL = 'http://localhost:5000';
const preferencesURL = 'http://localhost:5000/admin-preferences';
const pollURL = rootURL + '/poll?date=' + testYearMonth + '-01' + '&tab=one';
const attendanceURL = rootURL + '/poll?date=' + testYearMonth + '-01' + '&tab=two';
const paymentsURL = rootURL + '/poll?date=' + testYearMonth + '-01' + '&tab=three';
const aliasURL = rootURL + '/poll?date=' + testYearMonth + '-01' + '&tab=four';
const fakeLoginURL = rootURL + '/auth/fake';
var playerCostPerGame = 4;
var newPlayerIndex = 0;
var testFinancialYear = 2050;
var originalFinancialYear;
const localeDateOptions = { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric', };

async function waitUntilAfterHoldingText(element, holdingText) {
  try {
    for (var i = 0; i < 20; i ++) {
      var currentText = await element.getText();
      if (currentText != "" && !currentText.includes(holdingText)) {
        return true;
      }
      await new Promise(r => setTimeout(r, 200)); // sleep 0.2s
    }
  } catch (error) {
    return false;
  }
  // timeout exceeded so return false
  return false;
}

async function deleteAllTestData() {
  // delete all data from test month
  var returnValue = await indexDBUtils.deleteGameMonth(testYearMonth);
  var returnValue = await indexDBUtils.deleteGameMonth(test2YearMonth);
  var returnValue = await indexDBUtils.deleteGameMonth("2050-03");
  var returnValue = await indexDBUtils.deleteGameMonth("2050-04");
  var returnValue = await indexDBUtils.deleteGameMonth("2050-05");
  var returnValue = await indexDBUtils.deleteGameMonth("2050-06");
  var unitTestUserList = await indexDBUtils.getAllUnitTestUserList("UnitTest");
  for (var i = 0; i < unitTestUserList.length; i ++) {
    returnValue = await indexDBUtils.deleteTestDataForPlayer(unitTestUserList[i]);
  }
  // delete the GameWeekPreview data
  const response = await fetch(rootURL + '/schedule/delete-draft-list-for-admins', {
    method: "GET", headers: { "X-Appengine-Cron": "true", },
  });
}

// the main test data - availability and attendance
var testData = { "playerAvailability": [], "weeklyAttendanceGoals": {} };
// Summary data used for the tests - generated from the main test data
var testDataTotals = { "teamGenerator": [], "chargeTotals": {}, "playerTotals": {} };

beforeAll(async () => {
  // initialise data for the first time
  for (var gameWeek=0; gameWeek<4; gameWeek++) {
    testData.weeklyAttendanceGoals[gameWeek] = { "players": {}, "status": {}, "score": {}, "expectedPayments": {} };
  }
  // read the csv file containing the player data
  await indexDBUtils.importTestDataFromCsv(testData.playerAvailability, testData.weeklyAttendanceGoals);
  console.log("testData.playerAvailability", JSON.stringify(testData.playerAvailability));
  console.log("testData.weeklyAttendanceGoals", JSON.stringify(testData.weeklyAttendanceGoals));
  // now calculate the test data totals to use in the tests
  await calculateTestDataTotals();
  console.log("testDataTotals.teamGenerator", JSON.stringify(testDataTotals.teamGenerator));
  console.log("testDataTotals.chargeTotals", JSON.stringify(testDataTotals.chargeTotals));
  console.log("testDataTotals.playerTotals", JSON.stringify(testDataTotals.playerTotals));
  // export is also available - not needed but sometimes useful to generate csv from json data
  //await indexDBUtils.exportTestDataToCsv(testData.playerAvailability, testData.weeklyAttendanceGoals);


  // now initialise the test framework
  driver = await new Builder().forBrowser('chrome').build();
  if (deleteDataBeforeTests) {
    await deleteAllTestData(); // ensure starting from clean DB
  }

  // perform login with fake/test user (need to click twice for some reason)
  await driver.get(fakeLoginURL);
  await getElementByIdAfterWaitClick("authHeaderLarge"); // wait until page ready
  await driver.get(fakeLoginURL);
  await getElementByIdAfterWaitClick("authHeaderLarge"); // wait until page ready
  // goto alias page, check logged in
  await driver.get(aliasURL);
  await getElementByIdAfterWaitClick("authHeaderLarge"); // wait until page ready
  const anchor = await querySelector("[id=\'authHeaderLarge\']", driver);
  const actual = await anchor.getText();
  const expected = "Fake User (Admin)";
  expect(actual).toEqual(expected);
})

afterAll(async () => {
  // quit browser
  driver.quit();
  if (deleteDataAfterTests) {
    await deleteAllTestData(); // clean up after the tests
  }
})



async function calculateTestDataTotals() {
  ////////////
  // now calc gameweek availability totals
  ////////////
  for (gameWeek=0; gameWeek<5; gameWeek++) {
    var weekAvailabilityTotal = 0;
    var weekAvailabilityPlayers = [];
    for (var i = 0; i < testData.playerAvailability.length; i ++) {
      var teamNumber = testData.playerAvailability[i]["week" + gameWeek + "attendance"];
      if (teamNumber && teamNumber > 0) {
        weekAvailabilityTotal++;
        weekAvailabilityPlayers.push(testData.playerAvailability[i].name);
      }
    }
    testDataTotals.teamGenerator[gameWeek] = { "attendanceTotal": weekAvailabilityTotal, "players": weekAvailabilityPlayers};
  }

  ////////////
  // now calculate expected costs and maintain a global counter
  ////////////
  for (var i = 0; i < testData.playerAvailability.length; i++) {
    var playerName = testData.playerAvailability[i].name;
    var thisPlayerTotal = { "redTotal": 0, "blueTotal": 0, "goalsTotal": 0, "won": 0, "drawn": 0, "lost": 0 };
    for (var gameWeek = 0; gameWeek < Object.keys(testData.weeklyAttendanceGoals).length; gameWeek++) {
      // get expected values
      var gamesPlayed = 0;
      var costs = 0;
      var expectedTeam = "0";
      var expectedGoals = "0";
      if (testData.weeklyAttendanceGoals[gameWeek].players[playerName]) {
        // player played to add costs
        if (testDataTotals.chargeTotals[playerName]) {
          // already in the list so increment
          testDataTotals.chargeTotals[playerName].played ++;
          testDataTotals.chargeTotals[playerName].owed += playerCostPerGame
        } else {
          // not in the list so add...
          testDataTotals.chargeTotals[playerName] = {"played": 1, "owed": playerCostPerGame };
        }

        // get this player total
        if (testDataTotals.playerTotals[playerName]) {
          thisPlayerTotal = testDataTotals.playerTotals[playerName]
        }
        // increment the totals
        var teamNumber = testData.weeklyAttendanceGoals[gameWeek].players[playerName].team;
        if (teamNumber == 1) {
          thisPlayerTotal.redTotal++;
          if (testData.weeklyAttendanceGoals[gameWeek].score.winner == 1) {
            thisPlayerTotal.won++;
          } else if (testData.weeklyAttendanceGoals[gameWeek].score.winner == 2) {
            thisPlayerTotal.lost++;
          } else {
            thisPlayerTotal.drawn++;
          }
        } else if (teamNumber == 2) {
          thisPlayerTotal.blueTotal++;
          if (testData.weeklyAttendanceGoals[gameWeek].score.winner == 2) {
            thisPlayerTotal.won++;
          } else if (testData.weeklyAttendanceGoals[gameWeek].score.winner == 1) {
            thisPlayerTotal.lost++;
          } else {
            thisPlayerTotal.drawn++;
          }
        }
        thisPlayerTotal.goalsTotal += testData.weeklyAttendanceGoals[gameWeek].players[playerName].goals;
      }
    }
    testDataTotals.playerTotals[playerName] = thisPlayerTotal;
  }
  //console.log(testDataTotals.chargeTotals);
}


function getRandomInt(max) {
  return Math.floor(Math.random() * max);
}

const NOT_USED_getElementByIdAfterWait = async (id, timeout = 2000) => {
   const el = await driver.wait(until.elementLocated(By.id(id)), timeout);
   return await driver.wait(until.elementIsVisible(el), timeout);
};
const getElementByIdAfterWaitClick = async (id, timeout = 2000, description = "") => {
  try {
   const el = await driver.wait(until.elementLocated(By.id(id)), timeout);
   await driver.wait(until.elementIsVisible(el), timeout);
   return await driver.wait(until.elementIsEnabled(el), timeout);
  } catch (error) {
    console.error(id, description, error)
    exit
  }
};

it ('01 - test fake user login', async () => {
  //if (!enabledTests <) { return };
  // perform login with fake/test user
  await driver.get(fakeLoginURL);
  await getElementByIdAfterWaitClick("authHeaderLarge"); // wait until page ready
  // goto alias page, check logged in
  await driver.get(aliasURL);
  const anchor = await querySelector("[id=\'authHeaderLarge\']", driver);
  const actual = await anchor.getText();
  const expected = "Fake User (Admin)";
  expect(actual).toEqual(expected);
})

it ('01a - set preferences to test year', async () => {
  if (!enabledTests) { return };
  await driver.get(preferencesURL);
  await driver.findElement(By.id('openFinancialYear')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, testFinancialYear);
  await driver.findElement(By.id('submit')).click();
  
  //////////////
  // now check that it saved correctly
  //////////////
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  await driver.get(preferencesURL);
  //const anchor = await querySelector("[id=\'openFinancialYear\']", driver);
  const anchor = await getElementByIdAfterWaitClick("openFinancialYear");
  const actual = Number(await anchor.getAttribute("value"));
  expect(actual).toEqual(testFinancialYear);
})

it ('02 - test adding players to mailing list', async () => {
  if (!enabledTests) { return };
  await driver.get(aliasURL);
  // check to see if any players are already added and maintain a global counter
  var newAliasIndex = 0;
  for (i=0; i<999; i++) {
    try {
      var element = await driver.findElement(By.id('player' + i + 'Alias'));
      newAliasIndex++;
    } catch (error) {
      i = 99999;
    }
  }

  // add some test players
  for (var i = 0; i < testData.playerAvailability.length; i ++) {
    await driver.findElement(By.id('addAlias')).click();
    var playerName = testData.playerAvailability[i].name;
    var playerEmail = testData.playerAvailability[i].email;
    var playerAlias = testData.playerAvailability[i].alias;
    await driver.findElement(By.id('player' + newAliasIndex + 'Alias')).sendKeys(playerName); // add name
    await driver.findElement(By.id('playerEmail' + newAliasIndex + 'Alias')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, playerEmail); // add name
    await driver.findElement(By.id('playerAlias' + newAliasIndex + 'Alias')).sendKeys(playerAlias); // add name
    newAliasIndex++;
  }
  // save
  await driver.findElement(By.id('saveAlias')).click();
  await driver.get(aliasURL);
  var saveAliasEl = await getElementByIdAfterWaitClick("saveAlias");

  //////////////
  // now check that it saved correctly
  //////////////
  var updatedAliasIndex = 0;
  // check to see if any players are already added and maintain a global counter
  for (i=0; i<9999; i++) {
    try {
      var element = await driver.findElement(By.id('player' + i + 'Alias'));
      updatedAliasIndex++;
    } catch (error) {
      i = 99999;
    }
  }
  //console.log("Updated Alias Index:", updatedAliasIndex);
  // should be the same as the first run
  expect(updatedAliasIndex).toEqual(newAliasIndex);

  // check player alias persisted
  for (var i = 0; i < testData.playerAvailability.length; i ++) {
    var aliasIndex = await findAlias(testData.playerAvailability[i].name);
    expect(aliasIndex > -1).toEqual(true);
  }
}, 10000)

// find a given alias name from the alias list, return the index of the alias if found (or -1 otherwise) 
async function findAlias(aliasName) {
  // check to see if the aliases are already added and maintain a global counter
  for (i=0; i<999; i++) {
    try {
      var element = await driver.findElement(By.id('player' + i + 'Alias'));
      const currentAliasName = await element.getAttribute("value");
      if (currentAliasName == aliasName) {
        return i;
      }
    } catch (error) {
      i = 99999;
    }
  }
  return -1;
}

it ('03 - test poll loads with correct month and no players', async () => {
  if (!enabledTests) { return };
  await driver.get(pollURL);

  const anchor = await querySelector("[id=\'gameMonthInput\']", driver);
  const actual = await anchor.getAttribute("value");
  const expected = testYearMonth;
  expect(actual).toEqual(expected);

  // check to see if any players are already added and maintain a global counter
  for (i=0; i<20; i++) {
    try {
      var element = await driver.findElement(By.id('player' + i + 'availability'));
      newPlayerIndex++;
    } catch (error) {
      i = 99999;
    }
  }
  //console.log("New Player Index:", newPlayerIndex);
  // should be empty - no players yet added
  expect(newPlayerIndex).toEqual(0);
})

it ('04 - test adding players to poll', async () => {
  if (!enabledTests) { return };
  await driver.get(pollURL);
  for (i=0; i<testData.playerAvailability.length; i++) {
    await driver.findElement(By.id('addPlayer')).click();
    await driver.findElement(By.id('player' + newPlayerIndex + 'availability')).sendKeys(testData.playerAvailability[i].name); // add name
    for (gameWeek=0; gameWeek<5; gameWeek++) {
      if (!testData.playerAvailability[i]["week" + gameWeek + "attendance"]) {
        // checked by default, so uncheck if false
        await driver.findElement(By.id('player' + newPlayerIndex + 'Week' + gameWeek + 'availability')).click(); // uncheck week 
      }
    }
    await driver.findElement(By.id('player' + newPlayerIndex + 'Editavailability')).click(); // now save

    // refresh page and check save worked
    await driver.get(pollURL);
    const anchor = await querySelector("[id=\'player" + newPlayerIndex + "availability\']", driver)
    const actual = await anchor.getAttribute("value")
    const expected = testData.playerAvailability[i].name;
    expect(actual).toEqual(expected)
    newPlayerIndex++;

    // check that auto generated teams are created and incremented appropriately
    if (i == 8) {
      await testPreviewTeamsPage(5, 4, 0);
      await driver.get(pollURL);
    } else if (i == 9) {
      await testPreviewTeamsPage(5, 5, 0);
      await driver.get(pollURL);
    } else if (i == 10) {
      await testPreviewTeamsPage(5, 5, 1);
      await driver.get(pollURL);
    } else if (i == 11) {
      await testPreviewTeamsPage(6, 6, 0);
      await driver.get(pollURL);
    } else if (i == 12) {
      await testPreviewTeamsPage(6, 6, 1);
      await driver.get(pollURL);
    }
  }
}, 40000)

// check that auto generated teams are created and incremented appropriately
async function testPreviewTeamsPage(expectedTeam1, expectedTeam2, expectedStandby) {
  var expectedTotal = expectedTeam1 + expectedTeam2 + expectedStandby;

  // check team preview
  await driver.get(rootURL + '/admin-team-preview?date=2050-01-01&algorithm=6');
  await getElementByIdAfterWaitClick("redPlayerSelect"); // wait until page ready
  var element = await driver.findElement(By.id('redPlayerSelect'));

  // check total no of players
  var allPlayerStatsText = await element.getText();
  var noOfPlayers = allPlayerStatsText.split(/\r\n|\r|\n/).length; // count no of lines
  expect(noOfPlayers).toEqual(expectedTotal);

  // check player selected as either red, blue or standby
  var redList = [];
  var blueList = [];
  var standbyList = [];
  var noOfMonthsMultiplier = 6;
  for (var i = 0; i < expectedTotal; i++) {
    var playerName = testData.playerAvailability[i].name;
    var redElement = await driver.findElement(By.id('redPlayerSelect' + playerName));
    var currentPlayerAlgorithm = "";
    var isRed = await redElement.isSelected();
    if (isRed) { redList.push(playerName); currentPlayerAlgorithm = await redElement.getText();}
    var blueElement = await driver.findElement(By.id('bluePlayerSelect' + playerName));
    var isBlue = await blueElement.isSelected();
    if (isBlue) { blueList.push(playerName); currentPlayerAlgorithm = await blueElement.getText();}
    var standbyElement = await driver.findElement(By.id('standbyPlayerSelect' + playerName));
    var isStandby = await standbyElement.isSelected();
    if (isStandby) { standbyList.push(playerName); currentPlayerAlgorithm = await standbyElement.getText();}
    // check only selected once
    var isSelectedOnce = Number(isRed) + Number(isBlue) + Number(isStandby);
    //console.log(playerName, isRed, isBlue, isStandby, isSelectedOnce);
    expect(isSelectedOnce).toEqual(1);
    //Test 07 (0.67)
    var expected = playerName + " (0.00)";
    expect(currentPlayerAlgorithm).toEqual(expected);
  }
  // because of the randomised start of either red or blue
  if (redList.length == expectedTeam1) {
    // assumed started with red, so check blue
    expect(blueList.length).toEqual(expectedTeam2);
  } else if (redList.length == expectedTeam2) {
    // assumed started with blue, so check red
    expect(blueList.length).toEqual(expectedTeam1);
  } else {
    // something else went wrong so error with a check to help with debug...
    expect(redList.length + " " + blueList.length).toEqual(expectedTeam1 + " " + expectedTeam2);
  }
  expect(standbyList.length).toEqual(expectedStandby);
}

it ('05 - test team generator', async () => {
  if (!enabledTests) { return };
  // second game of the Month should have 4 players
  await driver.get(rootURL + '/teams?date=' + testYearMonth + '-10' + '&algorithm=3');
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  var teams =  await driver.findElement(By.id('emailBody')).getAttribute("value"); 

  var gameWeek = 1;
  expect(teams).toContain(testDataTotals.teamGenerator[gameWeek].attendanceTotal + " players");
  for (i=0; i<testDataTotals.teamGenerator[gameWeek].players.length; i++) {
    expect(teams).toContain(testDataTotals.teamGenerator[gameWeek].players[i]);
  }

  // third game of the Month should have no players
  await driver.get(rootURL + '/teams?date=' + testYearMonth + '-17' + '&algorithm=3');
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  var teams =  await driver.findElement(By.id('emailBody')).getAttribute("value"); 
  expect(teams).toContain("0 players this week");
})

it ('06 - test adding attendace and goals', async () => {
  if (!enabledTests) { return };
  await addAttendanceAndTest(testData.weeklyAttendanceGoals, "2050-01-01");
}, 60000)

async function findPlayerAttendanceIndex(playerName) {
  // check to see if the aliases are already added and maintain a global counter
  var foundPlayerIndex = -1;
  for (i=0; i<Object.keys(testData.playerAvailability).length; i++) {
    //var currentPlayerName = await (await getElementByIdAfterWaitClick('player' + i + 'attendance')).getAttribute("value");
    var currentPlayerName = await driver.findElement(By.id('player' + i + 'attendance')).getAttribute("value");
    if (currentPlayerName == playerName) {
      foundPlayerIndex = i;
      i = 9999;
    }
    //console.log("Finding player", currentPlayerName, playerName, foundPlayerIndex);
  }
  return foundPlayerIndex;
}

async function addAttendanceAndTest(attendanceData, date) {
const thisAttendanceURL = rootURL + '/poll?date=' + date + '&tab=two';
for (var gameWeek = 0; gameWeek < 4; gameWeek++) {
//for (var gameWeek = 0; gameWeek < Object.keys(attendanceData).length; gameWeek++) {
    await new Promise(r => setTimeout(r, 1000)); // sleep 1s
    await driver.get(thisAttendanceURL);
    (await getElementByIdAfterWaitClick('week' + gameWeek + 'Editattendance')).click();
    //await driver.findElement(By.id('week' + gameWeek + 'Editattendance')).click();
    // add score
    (await getElementByIdAfterWaitClick('week' + gameWeek + 'Score1attendance')).sendKeys(attendanceData[gameWeek].score.team1goals); // add 
    //await driver.findElement(By.id('week' + gameWeek + 'Score1attendance')).sendKeys(attendanceData[gameWeek].score.team1goals); // add 
    (await getElementByIdAfterWaitClick('week' + gameWeek + 'Score2attendance')).sendKeys(attendanceData[gameWeek].score.team2goals); // add 
    //await driver.findElement(By.id('week' + gameWeek + 'Score2attendance')).sendKeys(attendanceData[gameWeek].score.team2goals); // add 

    for (const playerName in attendanceData[gameWeek].players) {
      var teamNumber = attendanceData[gameWeek].players[playerName].team;
      var playerIndex = await findPlayerAttendanceIndex(playerName);
      for (i=0; i<teamNumber; i++) {
        var retryCount = 0;
        while (retryCount < 10) {
          try {
            await driver.findElement(By.id('player' + playerIndex + 'Week' + gameWeek + 'attendance')).click(); // x -> red -> blue
            retryCount = 999;
          } catch (error) {
            // likely to be a StaleElementReferenceError or TimeoutError, retry for a max of 10
            retryCount++;
          }
        }
      }
      var goals = attendanceData[gameWeek].players[playerName].goals;
      for (i=0; i<goals; i++) {
        var retryCount = 0;
        while (retryCount < 10) {
          try {
            //await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
            await driver.findElement(By.id('player' + playerIndex + 'attendance')).click();
            //await new Promise(r => setTimeout(r, 10)); // sleep 0.01s
            retryCount = 999;
          } catch (error) {
            // likely to be a StaleElementReferenceError or TimeoutError, retry for a max of 10
            retryCount++;
          }
        }
      }
    }
    //console.log("Saving", gameWeek, Object.keys(attendanceData[gameWeek].players).length);

    if (Object.keys(attendanceData[gameWeek].players).length == 0) {
      // no players for this week - cancel week
      await driver.findElement(By.id('cancelCheckbox')).click();
      await driver.findElement(By.id('cancelWeekDescription')).sendKeys("Testing Cancellation"); // add description
    }

    (await getElementByIdAfterWaitClick('saveAttendanceButton')).click();
  }

  await new Promise(r => setTimeout(r, 1000)); // sleep 1s
  await driver.get(thisAttendanceURL);
  await new Promise(r => setTimeout(r, 1000)); // sleep 0.5s
  await getElementByIdAfterWaitClick('week0Editattendance');

  //////////////
  // now check that it saved correctly
  //////////////
  // check to see if any players are already added and maintain a global counter
  for (var playerIndex = 0; playerIndex < Object.keys(testData.playerAvailability).length; playerIndex++) {
    for (var gameWeek = 0; gameWeek < 4; gameWeek++) {
      //console.log("PlayerIndex:", playerIndex, "GameWeek:", gameWeek);
      // get currentValues
      var element = await driver.findElement(By.id('player' + playerIndex + 'attendance'));
      var playerName = await element.getAttribute("value");
      element = await driver.findElement(By.id('player' + playerIndex + 'Week' + gameWeek + 'attendance'));
      var teamNumber = await element.getAttribute("teamvalue");
      if (!teamNumber || teamNumber == "") { teamNumber = "0"};
      element = await driver.findElement(By.id('player' + playerIndex + 'Week' + gameWeek + 'attendanceGoals'));
      var goals = await element.getText();
      if (!goals || goals == "") { goals = "0"};

      // get expected values
      var expectedTeam = "0";
      var expectedGoals = "0";
      if (testData.weeklyAttendanceGoals[gameWeek].players[playerName]) {
        expectedTeam = "" + testData.weeklyAttendanceGoals[gameWeek].players[playerName].team;
        if (!expectedTeam || expectedTeam == "") { expectedTeam = "0"};
        expectedGoals = testData.weeklyAttendanceGoals[gameWeek].players[playerName].goals;
        if (!expectedGoals || expectedGoals == "" || expectedGoals == null) { expectedGoals = "0"};
      }
      //console.log("Week:", gameWeek, "Player:", playerName, testData.weeklyAttendanceGoals[gameWeek].players[playerName], "Team:", teamNumber, expectedTeam, "Goals:", goals, expectedGoals);
      expect(Number(teamNumber)).toEqual(Number(expectedTeam));
      expect(Number(goals)).toEqual(Number(expectedGoals));
    }
  }

  // check cancellation (hardcoded to week 2 for now)
  var cancelledGameWeek = 2;
  element = await driver.findElement(By.id('week' + cancelledGameWeek + 'ScoreSeparatorattendance'));
  var cancellationSeparator = await element.getText();
  expect(cancellationSeparator).toEqual("X");
  // click edit again, check "cancel" checkbox is checked, and description is correct
  (await getElementByIdAfterWaitClick('week' + cancelledGameWeek + 'Editattendance')).click();
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  element = await driver.findElement(By.id('cancelWeekDescription'));
  var cancelledDesc = await element.getAttribute("value");
  expect(cancelledDesc).toEqual("Testing Cancellation");
  element = await driver.findElement(By.id('cancelCheckbox'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);

}
it ('07 - test this month payments (pre-month close)', async () => {
  if (!enabledTests) { return };
  // check payments are showing in THIS MONTHS tally
  await driver.get(paymentsURL);
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  for (const playerName in testDataTotals.chargeTotals) {
    var anchor = await querySelector("[id=\'playertrue" + playerName + "OwedPayment\']", driver);
    //var anchor = await getElementByIdAfterWaitClick("playertrue" + playerName + "OwedPayment", 2000, "TESTING PAYMENTS (T07) " + playerName);
    var actual = await anchor.getText();
    expect(actual).toEqual("£" + testDataTotals.chargeTotals[playerName].owed)
  }
})

it ('08 - test closing month and check ledger', async () => {
  if (!enabledTests) { return };
  // refresh page and check payments
  await driver.get(attendanceURL);
  await driver.findElement(By.id('closeMonthGeneratePaymentsButton')).click(); 

  // reload and check it is already closed
  await driver.get(attendanceURL);
  var actual = "";
  var retryCount = 0;
  while (retryCount < 10) {
    try {
      actual = await driver.findElement(By.id('closeMonthGeneratePaymentsButton')).getAttribute("innerText");
      retryCount = 999;
    } catch (error) {
      // likely to be a StaleElementReferenceError or TimeoutError, retry for a max of 10
      retryCount++;
    }
  }
  expect(actual).toEqual("Month already closed");

  // now check payments are showing in OUTSTANDING BALANCE tally
  await driver.get(paymentsURL);

  for (const playerName in testDataTotals.chargeTotals) {
    var anchor = await querySelector("[id=\'playerfalse" + playerName + "OwedPayment\']", driver);
    var actual = await anchor.getText();
    expect(actual).toEqual("£" + testDataTotals.chargeTotals[playerName].owed)
  }
}, 10000)

it ('20a - test adding second players, attendace and goals', async () => {
  if (!enabledTests) { return };
  await indexDBUtils.copyCollection("2050-01-01", "2050-02-01");
})

it ('22 - test closing second month and check ledger incremented appropriately', async () => {
  if (!enabledTests) { return };
  const test2YearMonth = "2050-02";
  const attendance2URL = rootURL + '/poll?date=' + test2YearMonth + '-01' + '&tab=two';
  const payments2URL = rootURL + '/poll?date=' + test2YearMonth + '-01' + '&tab=three';

  // refresh page and check payments
  await driver.get(attendance2URL);
  await driver.findElement(By.id('closeMonthGeneratePaymentsButton')).click(); 

  // reload and check it is already closed
  await driver.get(attendance2URL);
  var actual = "";
  var retryCount = 0;
  while (retryCount < 10) {
    try {
      actual = await driver.findElement(By.id('closeMonthGeneratePaymentsButton')).getAttribute("innerText");
      retryCount = 999;
    } catch (error) {
      // likely to be a StaleElementReferenceError or TimeoutError, retry for a max of 10
      retryCount++;
    }
  }
  expect(actual).toEqual("Month already closed");

  // now check payments are showing in OUTSTANDING BALANCE tally
  await driver.get(payments2URL);

  var totalOwed = 0;
  for (const playerName in testDataTotals.chargeTotals) {
    var element;
    try {
      element = await driver.findElement(By.id('playerfalse' + playerName + 'OwedPayment'));
    } catch (error) {
      // error 
      //console.log(error)
    }

    if (element) {
      var actual = await element.getText();
      expect(playerName + actual).toEqual(playerName + "£" + (testDataTotals.chargeTotals[playerName].owed*2))
      totalOwed += testDataTotals.chargeTotals[playerName].owed*2;
    } else {
      expect(playerName + " £" + testDataTotals.chargeTotals[playerName].owed).toEqual(playerName + " £0")
    }
  }

  var element = await querySelector("[id=\'OverallOutstandingTotalfalse\']", driver);
  var actual = await element.getText();
  expect(actual).toEqual("£" + totalOwed);

  //////////////////
  // test teams/email generator includes the correct payments
  await driver.get(rootURL + '/teams?date=' + test2YearMonth + '-01' + '&algorithm=3&template=payments');
  for (const playerName in testDataTotals.chargeTotals) {
    var element;
    try {
      element = await driver.findElement(By.id('playertrue' + playerName + 'OwedPayment'));
    } catch (error) {
      // error 
      //console.log(error)
    }

    if (element) {
      var actual = await element.getText();
      expect(playerName + actual).toEqual(playerName + "£" + (testDataTotals.chargeTotals[playerName].owed*2))
      totalOwed += testDataTotals.chargeTotals[playerName].owed*2;
    } else {
      expect(playerName + " £" + testDataTotals.chargeTotals[playerName].owed).toEqual(playerName + " £0")
    }
  }

  //////////////////
  // test teams/email generator includes the correct payments
  await driver.get(rootURL + '/teams?date=' + test2YearMonth + '-01' + '&algorithm=3&template=availability');
  for (const playerName in testDataTotals.chargeTotals) {
    var element;
    try {
      element = await driver.findElement(By.id('playertrue' + playerName + 'OwedPayment'));
    } catch (error) {
      // error 
      //console.log(error)
    }

    if (element) {
      var actual = await element.getText();
      expect(playerName + actual).toEqual(playerName + "£" + (testDataTotals.chargeTotals[playerName].owed*2))
      totalOwed += testDataTotals.chargeTotals[playerName].owed*2;
    } else {
      expect(playerName + " £" + testDataTotals.chargeTotals[playerName].owed).toEqual(playerName + " £0")
    }
  }
}, 11000)


it ('23 - test payments are showing in OUTSTANDING BALANCE tally', async () => {
  if (!enabledTests) { return };
  const test2YearMonth = "2050-02";
  const payments2URL = rootURL + '/poll?date=' + test2YearMonth + '-01' + '&tab=three';
  await driver.get(payments2URL);

  var element = await querySelector("[id=\'OverallOutstandingTotalfalse\']", driver);
  var actual = await element.getText();
  expect(actual).not.toEqual("£0");
})

it ('25 - test stats', async () => {
  if (!enabledTests) { return };
  // clone collection to add more months of data for algorithms
  var noOfMonthsMultiplier = 6;
  //await indexDBUtils.copyCollection("2050-01-01", "2050-02-01");
  await indexDBUtils.copyCollection("2050-01-01", "2050-03-01");
  await indexDBUtils.copyCollection("2050-01-01", "2050-04-01");
  await indexDBUtils.copyCollection("2050-01-01", "2050-05-01");
  await indexDBUtils.copyCollection("2050-01-01", "2050-06-01");
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  expect(true).toEqual(true);

  // second game of the Month should have 4 players
  await driver.get(rootURL + '/teams?date=2050-06-13&algorithm=3');
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  var teams =  await driver.findElement(By.id('emailBody')).getAttribute("value"); 

  var gameWeek = 1;
  expect(teams).toContain(testDataTotals.teamGenerator[gameWeek].attendanceTotal + " players");
  for (i=0; i<testDataTotals.teamGenerator[gameWeek].players.length; i++) {
    expect(teams).toContain(testDataTotals.teamGenerator[gameWeek].players[i]);
  }

  // check algorithm1 (win ratio)
  await driver.get(rootURL + '/teams?date=2050-06-20' + '&algorithm=1');
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  var teams =  await driver.findElement(By.id('emailBody')).getAttribute("value"); 
  expect(teams).toContain("0 players this week");

  var element = await driver.findElement(By.id('paymentsEntryDiv'));
  var allPlayerStatsText = await element.getText();
  for (const playerName in testDataTotals.chargeTotals) {
    var stats = getPlayerStats(playerName, noOfMonthsMultiplier);
    //4.00  (6|6|0)   Test 09
    var expected = stats.winRatio.toFixed(2) + "  (" + stats.playerWon + "|" + stats.playerDrawn + "|" + stats.playerLost + ")   " + playerName
    expect(allPlayerStatsText).toContain(expected);
  }

  // check algorithm6 (goals per game)
  await driver.get(rootURL + '/teams?date=2050-06-27' + '&algorithm=6');
  await new Promise(r => setTimeout(r, 500)); // sleep 0.5s
  var teams =  await driver.findElement(By.id('emailBody')).getAttribute("value"); 
  expect(teams).toContain("10 players this week");

  var element = await driver.findElement(By.id('paymentsEntryDiv'));
  var allPlayerStatsText = await element.getText();
  for (const playerName in testDataTotals.chargeTotals) {
    var stats = getPlayerStats(playerName, noOfMonthsMultiplier);
    //0.50    Test 09
    var expected = stats.goalsPerGame.toFixed(2) + "    " + playerName;
    expect(allPlayerStatsText).toContain(expected);
  }
}, 11000)

function getPlayerStats(playerName, noOfMonthsMultiplier) {
  var stats = {};
  stats.playerName = playerName;

  stats.playerGoals = testDataTotals.playerTotals[playerName].goalsTotal * noOfMonthsMultiplier;
  stats.playerReds = testDataTotals.playerTotals[playerName].redTotal * noOfMonthsMultiplier;
  stats.playerBlues = testDataTotals.playerTotals[playerName].blueTotal * noOfMonthsMultiplier;
  stats.playerWon = testDataTotals.playerTotals[playerName].won * noOfMonthsMultiplier;
  stats.playerDrawn = testDataTotals.playerTotals[playerName].drawn * noOfMonthsMultiplier;
  stats.playerLost = testDataTotals.playerTotals[playerName].lost * noOfMonthsMultiplier;

  // now perform calculation of each algorithm
  stats.totalPlayed = (stats.playerWon + stats.playerDrawn + stats.playerLost);
  stats.goalsPerGame = stats.playerGoals / stats.totalPlayed;
  stats.winRatio = stats.playerWon / stats.totalPlayed;
  //stats.winRatio = Number(((stats.playerWon + (stats.playerDrawn/2)) / stats.totalPlayed)).toFixed(2);
  /////////////
  // TODO: NEED TO FIGURE OUT WHY winRatio WORKS ON /teams, but winRatioStats WORKS ON /stats 
  /////////////
  stats.winRatioStats = Number(((stats.playerWon + (stats.playerDrawn/2)) / (stats.playerWon + stats.playerLost + stats.playerDrawn)).toFixed(2));
  
  return stats;
}


it ('25 - test stats', async () => {
  if (!enabledTests) { return };
  var noOfMonthsMultiplier = 6;
  var gameWeeksTotal = noOfMonthsMultiplier * 4;

  // now check the stats are showing the correct values
  await driver.get(rootURL + '/stats?date=2050-06-01&dateRange=6&statChart=Total%20Goals&tab=one');
  
  //await getElementByIdAfterWaitClick('week' + gameWeek + 'Editattzendance')
  var hiddenStats =  await driver.findElement(By.id('oneHiddenStats')).getAttribute("innerHTML"); 
  //["Won","Lost","Drawn","Total Games","Total Red","Total Blue","Player Name","Week No","Win Ratio","Total Goals"]
  //[6,0,6,12,0,12,"UnitTest 09",24,0.75,6]
  for (const playerName in testDataTotals.chargeTotals) {
    var stats = getPlayerStats(playerName, noOfMonthsMultiplier);
    //console.log("Player", playerName, stats);
    var expected = '[' + stats.playerWon + ',' + stats.playerLost + ',' + stats.playerDrawn + ',' + 
      stats.totalPlayed + ',' + stats.playerReds + ',' + stats.playerBlues + ',"' + 
      playerName + '",' + gameWeeksTotal + ',' + stats.winRatioStats + ',' + stats.playerGoals + ']';
    expect(hiddenStats).toContain(expected);
  }


  // now check the stats are showing the correct values
  await driver.get(rootURL + '/stats?date=2050-06-01&dateRange=6&statChart=Total%20Goals&tab=seven');
  
  //await getElementByIdAfterWaitClick('week' + gameWeek + 'Editattzendance')
  var hiddenStats =  await driver.findElement(By.id('sevenHiddenStats')).getAttribute("innerHTML"); 
  //expected = '"UnitTest 09":[6,0,6,6]'
  for (const playerName in testDataTotals.chargeTotals) {
    var stats = getPlayerStats(playerName, noOfMonthsMultiplier);
    //console.log("Player", playerName, stats);
    var expected = '"' + playerName + '":[' + stats.playerWon + ',' + stats.playerLost + ',' + stats.playerDrawn + ',' + stats.playerGoals + ']';
    expect(hiddenStats).toContain(expected);
  }

}, 3000)

it ('26 - test admin-team-preview', async () => {
  if (!enabledTests) { return };

  // check team preview
  await driver.get(rootURL + '/admin-team-preview?date=2050-06-01&algorithm=6');
  await getElementByIdAfterWaitClick("redPlayerSelect"); // wait until page ready

  // check player selected as either red, blue or standby
  var redList = [];
  var blueList = [];
  var standbyList = [];
  var noOfMonthsMultiplier = 6;
  //for (const playerName in testDataTotals.chargeTotals) {
  for (var i = 0; i < testData.playerAvailability.length; i++) {
    var playerName = testData.playerAvailability[i].name;
    var redElement = await driver.findElement(By.id('redPlayerSelect' + playerName));
    var currentPlayerAlgorithm = "";
    var isRed = await redElement.isSelected();
    if (isRed) { redList.push(playerName); currentPlayerAlgorithm = await redElement.getText();}
    var blueElement = await driver.findElement(By.id('bluePlayerSelect' + playerName));
    var isBlue = await blueElement.isSelected();
    if (isBlue) { blueList.push(playerName); currentPlayerAlgorithm = await blueElement.getText();}
    var standbyElement = await driver.findElement(By.id('standbyPlayerSelect' + playerName));
    var isStandby = await standbyElement.isSelected();
    if (isStandby) { standbyList.push(playerName); currentPlayerAlgorithm = await standbyElement.getText();}
    // check only selected once
    var isSelectedOnce = Number(isRed) + Number(isBlue) + Number(isStandby);
    //console.log(playerName, isRed, isBlue, isStandby, isSelectedOnce);
    expect(isSelectedOnce).toEqual(1);

    var stats = getPlayerStats(playerName, noOfMonthsMultiplier);
    //Test 07 (0.67)
    var playerGoalsPerGame = (Number(stats.goalsPerGame)) ? stats.goalsPerGame.toFixed(2) : "0.00";
    var expected = playerName + " (" + playerGoalsPerGame + ")";
    expect(currentPlayerAlgorithm).toEqual(expected);
  }
  expect(redList.length).toEqual(6);
  expect(blueList.length).toEqual(6);
  expect(standbyList.length).toEqual(2);
}, 3000)

it ('30 - test historical games are correct', async () => {
  if (!enabledHistoricTests) { return };

  // check no availability data in 2019 (it was stored in doodle then)
  await driver.get(rootURL + '/poll?date=2019-08-01&tab=one');
  await getElementByIdAfterWaitClick("addPlayer"); // wait until page ready
  try {
    var element = await driver.findElement(By.id('player0availability'));
    // should not get here - this element should not exist
    expect(element).toEqual("ERROR - SHOULD NOT GET HERE - EXCEPTION EXPECTED");
  } catch (error) {
    // should get here...
    expect(true).toEqual(true);
  }
  // check attendance shows played but no teams in 2019
  await driver.get(rootURL + '/poll?date=2019-08-01&tab=two');
  await getElementByIdAfterWaitClick("player0attendance"); // wait until page ready
  var element = await driver.findElement(By.id('player0attendance'));
  var playerName = await element.getAttribute("value");
  expect(playerName).toEqual("Adam B");
  element = await driver.findElement(By.id('player0Week0attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(true);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("99");
  element = await driver.findElement(By.id('player0Week0attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("");
  // check payment calculation still works in 2019
  await driver.get(rootURL + '/poll?date=2019-08-01&tab=three');
  await getElementByIdAfterWaitClick("playertrue0LinkPayment"); // wait until page ready
  var element = await driver.findElement(By.id('playertrueAdam BNamePayment'));
  var playerName = await element.getText();
  expect(playerName).toEqual("Adam B");
  var element = await driver.findElement(By.id('playertrue0LinkPayment'));
  var playerName = await element.getText();
  expect(playerName).toEqual("(PayPal £8)");

  // check availability data in 2022 (app first replaced doodle)
  await driver.get(rootURL + '/poll?date=2022-03-01&tab=one');
  await getElementByIdAfterWaitClick("player0availability"); // wait until page ready
  var element = await driver.findElement(By.id('player0availability'));
  var playerName = await element.getAttribute("value");
  expect(playerName).toEqual("Bower");
  var element = await driver.findElement(By.id('player0Week0availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);
  var element = await driver.findElement(By.id('player0Week1availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);
  var element = await driver.findElement(By.id('player0Week2availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);
  var element = await driver.findElement(By.id('player0Week3availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);
  // check attendance shows played but no teams in 2022
  await driver.get(rootURL + '/poll?date=2022-03-01&tab=two');
  await getElementByIdAfterWaitClick("player0attendance"); // wait until page ready
  var element = await driver.findElement(By.id('player0attendance'));
  var playerName = await element.getAttribute("value");
  expect(playerName).toEqual("Bower");
  element = await driver.findElement(By.id('player0Week0attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(false);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("0");
  element = await driver.findElement(By.id('player0Week0attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("");
  element = await driver.findElement(By.id('player0Week1attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(true);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("99");
  element = await driver.findElement(By.id('player0Week1attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("");
  // check payment calculation still works in 2019
  await driver.get(rootURL + '/poll?date=2022-03-01&&tab=three');
  await getElementByIdAfterWaitClick("playertrue0LinkPayment"); // wait until page ready
  var element = await driver.findElement(By.id('playertrueBowerNamePayment'));
  var playerName = await element.getText();
  expect(playerName).toEqual("Bower");
  var element = await driver.findElement(By.id('playertrue0LinkPayment'));
  var playerName = await element.getText();
  expect(playerName).toEqual("(PayPal £4)");

  // check availability data in 2023 (same as before - also testing bank hols)
  await driver.get(rootURL + '/poll?date=2023-05-01&tab=one');
  await getElementByIdAfterWaitClick("player0availability"); // wait until page ready
  var element = await driver.findElement(By.id('player0availability'));
  var playerName = await element.getAttribute("value");
  expect(playerName).toEqual("Craig S");
  var element = await driver.findElement(By.id('player0Week0availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);
  var isChecked = await element.getAttribute("type");
  expect(isChecked).toEqual("hidden"); // bank holiday so should be hidden
  var element = await driver.findElement(By.id('player0Week1availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);
  var element = await driver.findElement(By.id('player0Week2availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);
  var element = await driver.findElement(By.id('player0Week3availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);
  var element = await driver.findElement(By.id('player0Week4availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);
  // check attendance shows played but no teams in 2023
  await driver.get(rootURL + '/poll?date=2023-05-01&tab=two');
  await getElementByIdAfterWaitClick("player0attendance"); // wait until page ready
  var element = await driver.findElement(By.id('player0attendance'));
  var playerName = await element.getAttribute("value");
  expect(playerName).toEqual("Craig S");
  // 2 x bank hols
  element = await driver.findElement(By.id('player0Week0attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(false);
  element = await driver.findElement(By.id('player0Week1attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(false);
  // first game
  element = await driver.findElement(By.id('player0Week2attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(false);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("0");
  element = await driver.findElement(By.id('player0Week2attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("");
  element = await driver.findElement(By.id('player0Week3attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(true);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("1");
  element = await driver.findElement(By.id('player0Week3attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("");
  // check payment calculation still works in 2019
  await driver.get(rootURL + '/poll?date=2023-05-01&&tab=three');
  await getElementByIdAfterWaitClick("playertrue0LinkPayment"); // wait until page ready
  var element = await driver.findElement(By.id('playertrueCraig SNamePayment'));
  var playerName = await element.getText();
  expect(playerName).toEqual("Craig S");
  var element = await driver.findElement(By.id('playertrue0LinkPayment'));
  var playerName = await element.getText();
  expect(playerName).toEqual("(PayPal £4)");


  // check availability data in 2024 (same as before)
  await driver.get(rootURL + '/poll?date=2024-01-01&tab=one');
  await getElementByIdAfterWaitClick("player0availability"); // wait until page ready
  var element = await driver.findElement(By.id('player2availability'));
  var playerName = await element.getAttribute("value");
  expect(playerName).toEqual("Craig");
  var element = await driver.findElement(By.id('player2Week0availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);
  var isChecked = await element.getAttribute("type");
  expect(isChecked).toEqual("hidden"); // bank holiday so should be hidden
  var element = await driver.findElement(By.id('player2Week1availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);
  var element = await driver.findElement(By.id('player2Week2availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);
  var element = await driver.findElement(By.id('player2Week3availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);
  var element = await driver.findElement(By.id('player2Week4availability'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);
  // check attendance shows played but no teams in 2023
  await driver.get(rootURL + '/poll?date=2024-01-01&tab=two');
  await getElementByIdAfterWaitClick("player0attendance"); // wait until page ready
  var element = await driver.findElement(By.id('player2attendance'));
  var playerName = await element.getAttribute("value");
  expect(playerName).toEqual("Craig S");
  element = await driver.findElement(By.id('player2Week0attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(false); // bank hol
  element = await driver.findElement(By.id('player2Week1attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(true);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("2");
  element = await driver.findElement(By.id('player2Week1attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("2");
  element = await driver.findElement(By.id('player2Week2attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(true);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("2");
  element = await driver.findElement(By.id('player2Week2attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("1");
  element = await driver.findElement(By.id('player2Week3attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(true);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("2");
  element = await driver.findElement(By.id('player2Week3attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("1");
  element = await driver.findElement(By.id('player2Week4attendance'));
  var played = await element.isSelected();
  expect(played).toEqual(true);
  var teamNumber = await element.getAttribute("teamvalue");
  expect(teamNumber).toEqual("1");
  element = await driver.findElement(By.id('player2Week4attendanceGoals'));
  var goals = await element.getText();
  expect(goals).toEqual("");
  // check payment calculation still works in 2019
  await driver.get(rootURL + '/poll?date=2024-01-01&&tab=three');
  await getElementByIdAfterWaitClick("playertrue1LinkPayment"); // wait until page ready
  var element = await driver.findElement(By.id('playertrueCraig SNamePayment'));
  var playerName = await element.getText();
  expect(playerName).toEqual("Craig S");
  var element = await driver.findElement(By.id('playertrue1LinkPayment'));
  var playerName = await element.getText();
  expect(playerName).toEqual("(PayPal £16)");

}, 3000)


it ('40 - test weekly cron', async () => {
  if (!enabledTests) { return };

  var dateString = "2050-06-06";
  var dateStringLocale = new Date(dateString).toLocaleDateString('en-GB', localeDateOptions);
  var expectedRed = 6, expectedBlue = 6, expectedStandby = 2; // hardcoded for now
  var expectedTotal = expectedRed + expectedBlue + expectedStandby; 

  // delete any previous teams list
  var response = await fetch(rootURL + '/schedule/delete-draft-list-for-admins', {
    method: "GET", headers: { "X-Appengine-Cron": "true", },
  });
  //console.log(response);
  expect(response.status).toEqual(200);

  // check it loads a GENERATED team list
  await driver.get(rootURL + '/admin-team-preview?date=' + dateString + '&algorithm=6');
  var title = await driver.findElement(By.id('teamTitle')).getText();
  expect(title).toEqual("Generated: " + dateStringLocale);
  var teamList = await driver.findElement(By.id('teamList')).getAttribute("value"); 
  expect(teamList).toContain("Total Players: " + expectedTotal);

  // run cron to save the generate teams
  var response = await fetch(rootURL + '/schedule/generate-draft-list-for-admins?date=' + dateString, {
    method: "GET", headers: { "X-Appengine-Cron": "true", },
  });
  //console.log(response);
  expect(response.status).toEqual(200);

  // check it retries a SAVED team list
  await driver.get(rootURL + '/admin-team-preview?date=' + dateString + '&algorithm=6');
  var title = await driver.findElement(By.id('teamTitle')).getText();
  expect(title).toEqual("Saved: " + dateStringLocale);
  var teamList = await driver.findElement(By.id('teamList')).getAttribute("value"); 
  expect(teamList).toContain("Total Players: " + expectedTotal);
  // check total no of players
  var element = await driver.findElement(By.id('redPlayerSelect'));
  var allPlayerStatsText = await element.getText();
  var noOfPlayers = allPlayerStatsText.split(/\r\n|\r|\n/).length; // count no of lines
  expect(noOfPlayers).toEqual(expectedTotal);

  // run the final cron to delete the teams list
  var response = await fetch(rootURL + '/schedule/delete-draft-list-for-admins', {
    method: "GET", headers: { "X-Appengine-Cron": "true", },
  });
  //console.log(response);
  expect(response.status).toEqual(200);

  // check it loads a GENERATED team list again
  await driver.get(rootURL + '/admin-team-preview?date=' + dateString + '&algorithm=6');
  var title = await driver.findElement(By.id('teamTitle')).getText();
  expect(title).toEqual("Generated: " + dateStringLocale);
  var teamList = await driver.findElement(By.id('teamList')).getAttribute("value"); 
  expect(teamList).toContain("Total Players: " + expectedTotal);

}, 3000)


it ('41 - test mailing list', async () => {
  if (!enabledTests) { return };

  var fullName = "UnitTest Alias01";
  var email = fullName.replace(/ /, '') + "@test.com";
  var nameAliasKey = fullName.substring(0, fullName.trim().lastIndexOf(" ") + 2);
  //console.log("Name and Alias...", fullName, nameAliasKey)

  // go to the aliases page and check the user is NOT listed
  await driver.get(aliasURL);
  var saveAliasEl = await getElementByIdAfterWaitClick("saveAlias");
  var aliasIndex = await findAlias(nameAliasKey);
  expect(aliasIndex == -1).toEqual(true);

  // goto mailing list and add a new user and check that it save correctly
  await driver.get(rootURL + '/mailing-list');
  await driver.findElement(By.id('subscribeChoice')).click();
  await driver.findElement(By.id('fullname')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, fullName);
  await driver.findElement(By.id('email')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, email);
  await driver.findElement(By.id('submit')).click();
  await waitUntilAfterHoldingText(driver.findElement(By.id('response')), "Submitting");
  var success = await driver.findElement(By.id('response')).getText();
  expect(success).toContain("Success!");
  // go to the aliases page and check the user is listed (but inactive)
  await driver.get(aliasURL);
  var saveAliasEl = await getElementByIdAfterWaitClick("saveAlias");
  var aliasIndex = await findAlias(nameAliasKey);
  expect(aliasIndex > -1).toEqual(true);
  element = await driver.findElement(By.id('playerActive' + aliasIndex + 'Alias'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);

  // add the same user and check that it save correctly (because already on the list)
  await driver.get(rootURL + '/mailing-list');
  await driver.findElement(By.id('subscribeChoice')).click();
  await driver.findElement(By.id('fullname')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, fullName);
  await driver.findElement(By.id('email')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, email);
  await driver.findElement(By.id('submit')).click();
  await waitUntilAfterHoldingText(driver.findElement(By.id('response')), "Submitting");
  var success = await driver.findElement(By.id('response')).getText();
  expect(success).toContain("Success!");
  // go to the aliases page and check the user is listed (but inactive)
  await driver.get(aliasURL);
  var saveAliasEl = await getElementByIdAfterWaitClick("saveAlias");
  var aliasIndex = await findAlias(nameAliasKey);
  expect(aliasIndex > -1).toEqual(true);
  element = await driver.findElement(By.id('playerActive' + aliasIndex + 'Alias'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);

  // get the confirmation ID (sent by email) from DB and confirm...
  var aliasData = await indexDBUtils.getAliasData(nameAliasKey);
  //console.log("ALIAS CODE:", aliasData.code)
  var response = await fetch(rootURL + '/mailing-list?code=' + aliasData.code);
  expect(response.status).toEqual(200);
  // go to the aliases page and check the user is listed (and active)
  await driver.get(aliasURL);
  var saveAliasEl = await getElementByIdAfterWaitClick("saveAlias");
  var aliasIndex = await findAlias(nameAliasKey);
  expect(aliasIndex > -1).toEqual(true);
  element = await driver.findElement(By.id('playerActive' + aliasIndex + 'Alias'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(true);

  // add the same user and check that it save correctly (because already on the list)
  await driver.get(rootURL + '/mailing-list');
  await driver.findElement(By.id('subscribeChoice')).click();
  await driver.findElement(By.id('fullname')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, fullName);
  await driver.findElement(By.id('email')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, email);
  await driver.findElement(By.id('submit')).click();
  await waitUntilAfterHoldingText(driver.findElement(By.id('response')), "Submitting");
  var success = await driver.findElement(By.id('response')).getText();
  expect(success).toContain("Success!");


  // add a conflicting user and check that it fails
  await driver.findElement(By.id('fullname')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, fullName + "DUPE");
  await driver.findElement(By.id('email')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, email + "DUPE");
  await driver.findElement(By.id('submit')).click();
  await waitUntilAfterHoldingText(driver.findElement(By.id('response')), "Submitting");
  var success = await driver.findElement(By.id('response')).getText();
  expect(success).toContain("Error!");

  // now unsubscribe...
  await driver.findElement(By.id('unsubscribeChoice')).click();
  await driver.findElement(By.id('email')).sendKeys(Key.chord(Key.CONTROL, "a"), Key.DELETE, email);
  await driver.findElement(By.id('submit')).click();
  await waitUntilAfterHoldingText(driver.findElement(By.id('response')), "Submitting");
  var success = await driver.findElement(By.id('response')).getText();
  expect(success).toContain("Success!");
  // go to the aliases page and check the user is listed (but inactive)
  await driver.get(aliasURL);
  var saveAliasEl = await getElementByIdAfterWaitClick("saveAlias");
  var aliasIndex = await findAlias(nameAliasKey);
  expect(aliasIndex > -1).toEqual(true);
  element = await driver.findElement(By.id('playerActive' + aliasIndex + 'Alias'));
  var isChecked = await element.isSelected();
  expect(isChecked).toEqual(false);

}, 10000)
