const fs = require('fs');
const util = require('util');

// initialise DB use for tests
const Firestore = require('@google-cloud/firestore');
const firestore = new Firestore({
  projectId: 'tensile-spirit-360708',
  keyFilename: './keyfile.json',
});

// firstly, check using emulator (don't overwrite production data!)
if (process.env.FIRESTORE_EMULATOR_HOST) {
  //console.log("TESTING AGAINST LOCAL FIREBASE EMULATOR")
} else {
  console.log("ERROR, RUNNING PRODUCTION SO ABORTING.  Please run local emulator and set FIRESTORE_EMULATOR_HOST env var.");
  force_quit // force an error to quite
}

// get all data from DB
async function getAllDataFromDB() {
  // get a list of all collections
  var allCollections = [];
  await firestore.listCollections().then(snapshot=>{
    snapshot.forEach(snaps => {
      allCollections.push(snaps["_queryOptions"].collectionId);
    })
  })
  .catch(error => console.error(error));
  // loop through each collection and get the docs
  var allCollectionDocs = {};
  //allCollections.length
  for (var i=0; i<allCollections.length; i++) {
    var collectionId = allCollections[i];
    //console.log("Collecting docs from:", collectionId);
    const collection = await firestore.collection(collectionId)
    var allDocs = {};
    await collection.get().then((querySnapshot) => {
      const tempDoc = querySnapshot.docs.map((doc) => {
        var obj = { "id": doc.id, "data": doc.data() }
        return obj;
      })
      allDocs[tempDoc.id] = tempDoc;
      //console.log("ALL DOCS", tempDoc);
      allCollectionDocs[collectionId] = tempDoc;
    })
  }
  return allCollectionDocs;
}

// delete all docs in a month (e.g. 2025-01)
async function deleteGameMonth(yearMonthString) {
  var collectionId = "games_" + yearMonthString + "-01";
  const collection = await firestore.collection(collectionId);
  await collection.get().then((querySnapshot) => {
    const tempDoc = querySnapshot.docs.map((doc) => {
      //console.log("Deleting", doc.id);
      firestore.collection(collectionId).doc(doc.id).delete();
    })
  })
  return true;
}


// delete all docs in a month (e.g. 2025-01)
async function deleteTestDataForPlayer(playerName) {
  var aliasesDoc = await firestore.collection("ADMIN").doc("_aliases").get();
  var aliasesMap = aliasesDoc.data();
  if (aliasesMap) {
    // if aliases exists then assume the rest of it does
    delete aliasesMap[playerName];
    await firestore.collection("ADMIN").doc("_aliases").set(aliasesMap);
    await firestore.collection("OPEN_LEDGER").doc(playerName).delete();
    await firestore.collection("CLOSED_LEDGER").doc(playerName).delete();
  }
  return true;
}

// delete transient files - such as GameWeekPreview
async function deleteTransientFiles(playerName) {
  await firestore.collection("ADMIN").doc("GameWeekPreview").delete();
  return true;
}

async function getAttendance() {
  var gamesCollectionId = "2024-01-01";
  const docRef = await firestore.collection(gamesCollectionId).doc("_attendance");
  var existingDoc = await docRef.get();
  var attendanceData = await existingDoc.data();
  console.log("attendanceData", attendanceData);
}

async function copyCollection(srcMonth, destMonth) {
  const documents = await firestore.collection("games_" + srcMonth).get();
  for (const doc of documents.docs) {
    var docData = doc.data();
    if (doc.id == "_attendance") {
      // reopen the month since ledger is not being cloned
      docData.status = "open";
    }
    const docRef = firestore.collection("games_" + destMonth).doc(doc.id);
    await docRef.set(docData);
  }
}

function exportTestDataToCsv(testDataPlayerAvailability, testDataWeeklyAttendanceGoals) {
  var csvData = "";
  csvData += "Player Name,availability0,availability1,availability2,availability3,team0,team1,team2,team3,goals0,goals1,goals2,goals3\n";
  for (var j = 0; j < testDataPlayerAvailability.length; j ++) {
    var playerName = testDataPlayerAvailability[j]["name"];
    var attendanceString = "";
    var teamString = "";
    var goalsString = "";
    for (gameWeek=0; gameWeek<4; gameWeek++) {
      attendanceString += "," + testDataPlayerAvailability[j]["week" + gameWeek + "attendance"];
      if (testDataWeeklyAttendanceGoals[gameWeek].players[playerName]) {
        teamString += "," + testDataWeeklyAttendanceGoals[gameWeek].players[playerName].team;
        goalsString += "," + testDataWeeklyAttendanceGoals[gameWeek].players[playerName].goals;
      } else {
        teamString += ",";
        goalsString += ",";
      }
    }
    csvData += playerName + attendanceString + teamString + goalsString + "\n";
  }

  // now save csv to a file
  try {
    var filename = "tests/tmp-test-data-EXPORTED-DEBUG.csv";
    fs.writeFileSync(filename, csvData);
    console.log("Saving complete:", filename);
  } catch (err) {
    console.error(err);
  }
  //exit
}


async function importTestDataFromCsv(testDataPlayerAvailability, testDataWeeklyAttendanceGoals) {
  // read the backup file of all collections and docs
  var filename = "tests/test-player-data.csv";
  const readFileAsync = util.promisify(fs.readFile); 
  const data = await readFileAsync(filename, { encoding: 'utf-8' });
  //console.log("Loaded test data from file", data);

  var noOfColumns = 13;  // or however many elements there are in each row
  var allPlayerLines = data.split(/\r\n|\n/);
  var headings = allPlayerLines.shift();
  //console.log("Player Length:", allPlayerLines.length);

  // keep a tally of the goals for each team
  var calculateWeekScoreTotal = {
    '0': { 'team1goals':0, 'team2goals':0 }, 
    '1': { 'team1goals':0, 'team2goals':0 },
    '2': { 'team1goals':0, 'team2goals':0 },
    '3': { 'team1goals':0, 'team2goals':0 },
    '4': { 'team1goals':0, 'team2goals':0 } 
  };

  for (var i=0; i<allPlayerLines.length; i++) {
    var currentLine = allPlayerLines[i].split(',');
    var playerName = currentLine.shift();
    var playerEmail = playerName.replaceAll(" ", "_") + "@test.com"
    if (playerName && playerName != "") {
      testDataPlayerAvailability[i] = { 
        "name": playerName, "email": playerEmail, "alias": "T" + playerName,
        "week0attendance": (String(currentLine.shift()).toLowerCase() === 'true'), 
        "week1attendance": (String(currentLine.shift()).toLowerCase() === 'true'), 
        "week2attendance": (String(currentLine.shift()).toLowerCase() === 'true'), 
        "week3attendance": (String(currentLine.shift()).toLowerCase() === 'true')
      };

      // get which team the players are on for each week
      var teamWeek = [];
      for (var gameWeek=0; gameWeek<4; gameWeek++) {
        teamWeek[gameWeek] = currentLine.shift();
      }
      // get how many goals the player scored for each week
      var goals = [];
      for (var gameWeek=0; gameWeek<4; gameWeek++) {
        goals[gameWeek] = currentLine.shift();
        if (teamWeek[gameWeek] == 1) {
          calculateWeekScoreTotal[gameWeek].team1goals += Number(goals[gameWeek]);
        } else if (teamWeek[gameWeek] == 2) {
          calculateWeekScoreTotal[gameWeek].team2goals += Number(goals[gameWeek]);
        }
      }


      // now put all of the gameweek data together
      for (var gameWeek=0; gameWeek<4; gameWeek++) {
        var thisWeekData = testDataWeeklyAttendanceGoals[i];
        if (teamWeek[gameWeek] && teamWeek[gameWeek] != "") {
          testDataWeeklyAttendanceGoals[gameWeek].players[playerName] = {"team": teamWeek[gameWeek], "goals": Number(goals[gameWeek]) };
        }
      }
    }  
  }

  // finally, add the scores
  for (var gameWeek=0; gameWeek<4; gameWeek++) {
    var winner = 0;
    if (calculateWeekScoreTotal[gameWeek].team1goals > calculateWeekScoreTotal[gameWeek].team2goals) {
      winner = 1;
    } else if (calculateWeekScoreTotal[gameWeek].team1goals < calculateWeekScoreTotal[gameWeek].team2goals) {
      winner = 2;
    }
    calculateWeekScoreTotal[gameWeek].winner = winner;
    testDataWeeklyAttendanceGoals[gameWeek].score = calculateWeekScoreTotal[gameWeek];
  }

}

async function getAllUnitTestUserList(prefix) {
  var unitTestUserList = [];
  var aliasesDoc = await firestore.collection("ADMIN").doc("_aliases").get();
  var aliasesMap = aliasesDoc.data();
  for (const playerName in aliasesMap) {
    if (playerName.startsWith(prefix)) {
      unitTestUserList.push(playerName);
    }
  }
  return unitTestUserList;
}

async function getAliasData(name) {
  const docRef = await firestore.collection("ADMIN").doc("_aliases");
  var doc = await docRef.get();
  var aliasData = await doc.data();
  return aliasData[name];
}

module.exports = {
  getAllDataFromDB,
  deleteGameMonth,
  deleteTestDataForPlayer,
  deleteTransientFiles,
  getAttendance,
  copyCollection,
  exportTestDataToCsv,
  importTestDataFromCsv,
  getAllUnitTestUserList,
  getAliasData
};
