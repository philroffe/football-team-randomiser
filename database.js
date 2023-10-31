const express = require('express')
const path = require('path')
const PORT = process.env.PORT || 5000
const https = require('https')
const request = require('request');
const session = require('express-session');
const fs = require('fs');
const jsdom = require('jsdom');
const util = require('util')

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

var environment = "PRODUCTION";
// this happens automatically, but add a message in the log as a reminder
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log("RUNNING LOCALLY WITH FIREBASE EMULATOR");
  environment = "DEV";
}

if (process.argv[2]) { 
  switch(process.argv[2]) {
    case 'restore':
      console.log('Restoring DB...'); 
      var backupFilename = process.argv[3];
      if (!backupFilename) {
        // default to hardcoded backup if none specified
        //backupFilename = "delme/DB-Backup-date-2023-10-28T075830.640Z-ORIG.json";
        backupFilename = "DB-Backup-date-latest.json";
      }
      restoreDatabase(backupFilename);
      break;
    case 'backup':
      console.log('Backing up DB...');
      backupDatabase();
      break;
    case 'addCharges':
      console.log('Backing up DB...');
      addCharges();
      break;
    case 'viewDatabase':
      console.log('Viewing DB...');
      viewDatabase();
      break;
    default:
      console.log('Usage: npm run [backup|restore|addCharges|viewDatabase]');
  }
} else { 
  // npm run restore
  console.log('Usage: node database [restore|backup|view|addCharges]'); 
} 

////////////////////////
////////////////////////
////////////////////////
async function backupDatabase() {
  // firstly, check using production (don't want to backup emulator!)
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log("ERROR - RUNNING WITH LOCAL FIREBASE EMULATOR.  ABORTING", process.env.FIRESTORE_EMULATOR_HOST);
    return;
  } else {
    console.log("OK, performing backup of prod data to file", process.env.FIRESTORE_EMULATOR_HOST);
  }
  var allCollections = [];
  // get a list of all collections
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
    console.log("Collecting docs from:", collectionId);
    //const snapshot = await firestore.collection(collectionId).get();
    //var allDocs = await snapshot.docs.map(doc => doc.data());
    //allCollectionDocs[collectionId] = allDocs;

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
  console.log(allCollectionDocs);

  // now save allCollectionDocs to a file
  try {
    var filename = "DB-Backup-date-" + new Date().toISOString().replaceAll(':', '') + ".json";
    fs.writeFileSync(filename, JSON.stringify(allCollectionDocs));
    console.log("Saving complete:", filename);
    // file written successfully, so create/update symlink to latest file
    fs.symlinkSync(filename, "DB-Backup-date-latest.json");
  } catch (err) {
    console.error(err);
  }


}

async function restoreDatabase(filename) {
  // firstly, check using emulator (don't overwrite production data!)
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log("RESTORING TO LOCAL FIREBASE EMULATOR")
  } else {
    console.log("ERROR, RUNNING PRODUCTION SO ABORTING.  Please run local emulator and set FIRESTORE_EMULATOR_HOST env var.");
    return;
  }

  // read the backup file of all collections and docs
  var allCollectionDocsJson = await fs.readFileSync(filename);

  // now reverse the process to recreate the docs
  var allCollectionDocs = JSON.parse(allCollectionDocsJson);
  console.log(util.inspect(allCollectionDocs, {showHidden: false, depth: null, colors: true}));

  // loop through all collections
  for (const collectionId in allCollectionDocs) {
    console.log(collectionId);
    // loop through all docs
    for (const docId in allCollectionDocs[collectionId]) {
      var docName = allCollectionDocs[collectionId][docId].id;
      var docData = allCollectionDocs[collectionId][docId].data;
      if (docData.timestamp) {
        docData.timestamp = new Date(docData.timestamp._seconds*1000);
      }
      console.log("--", docName, docData);
      const collectionDocRef = await firestore.collection(collectionId).doc(docName);
      await collectionDocRef.set(docData);
    }
  }
  console.log("DB Restore complete from: " + filename);
}

async function viewDatabase() {
  const docRef = await firestore.collection("games_2023-10-01").doc("_attendance");
  var existingDoc = await docRef.get();
  console.log(existingDoc.data());


  const collection = await firestore.collection("games_2023-10-01")
  var allDocs = {};
  await collection.get().then((querySnapshot) => {
    const tempDoc = querySnapshot.docs.map((doc) => {
      var obj = { "id": doc.id, "data": doc.data() }
      return obj;
    })
    if (tempDoc.id == "_attendance") {
      console.log("ALL DOCS", util.inspect(tempDoc, {showHidden: false, depth: null, colors: true}));
    }
  })

  // get a list of all collections
  await firestore.listCollections().then(snapshot=>{
   snapshot.forEach(snaps => {
      console.log(snaps["_queryOptions"].collectionId);
    })
  })
  .catch(error => console.error(error));

  console.log("Environment:", environment);
  
  /**
  */
}


async function addCharges() {
  // firstly, check using emulator (don't overwrite production data!)
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log("RESTORING TO LOCAL FIREBASE EMULATOR")
  } else {
    console.log("ERROR, RUNNING PRODUCTION SO ABORTING");
    return;
  }

  
    // read the completed payments ledger
    const closedLedgerCollection = firestore.collection("CLOSED_LEDGER");
    const allClosedLedgerDocs = await closedLedgerCollection.get();
    var closedLedgers = {};
    allClosedLedgerDocs.forEach(doc => {
      var key = doc.id;
      var data = doc.data();
      data.amount = Number(data.amount);
      closedLedgers[key] = data;
    })
    var playerPaymentsCharges = closedLedgers;

    // fix bug where amounts are stored as strings rather than numbers
    Object.keys(playerPaymentsCharges).forEach(await function(playerName) {
      Object.keys(playerPaymentsCharges[playerName]).sort().forEach(function(paymentId) {
        playerPaymentsCharges[playerName][paymentId].amount = Number(playerPaymentsCharges[playerName][paymentId].amount);
        if (playerPaymentsCharges[playerName][paymentId].remainingAmount == undefined) {
          playerPaymentsCharges[playerName][paymentId].remainingAmount = Number(playerPaymentsCharges[playerName][paymentId].amount);
        }
/**
        //// take away from payment straight away if there is a corresponding cross-charge
        if (paymentId.startsWith("charge_") && playerPaymentsCharges[playerName][paymentId].paymentFrom) {
          console.log("ASSIGNING PAYMENT TO MANUAL CHARGE", playerName, paymentId);
          var payee = playerPaymentsCharges[playerName][paymentId].paymentFrom;
          var paidId = playerPaymentsCharges[playerName][paymentId].paid;
          
          // check if this payment is part of a cross-charge
          for (const chargeId in playerPaymentsCharges[payee]) {
            // loop through charges and find the matching one
            if (playerPaymentsCharges[payee][chargeId].paypalTransactionId == paidId) {
              playerPaymentsCharges[playerName][paymentId].remainingAmount -= 4
              //const playerLedgerDocRef = firestore.collection("CLOSED_LEDGER").doc(playerName);
              //playerLedgerDocRef.set(playerPaymentsCharges[playerName], { merge: true });
              console.log("ASSIGNING PAYMENT TO MANUAL CHARGE", playerName, paymentId, payee, paidId);
            }
          }
        }
        */
      });
    });

    // now check for cross-payments
    // loop through each player
    for (const playerName in playerPaymentsCharges) {
      // loop through each charge/payment
      for (const paymentId in playerPaymentsCharges[playerName]) {
        if (paymentId.startsWith("charge_") && playerPaymentsCharges[playerName][paymentId].paymentFrom) {
          // this payment needs cross-charging from another player
          var paymentFrom = playerPaymentsCharges[playerName][paymentId].paymentFrom;
          var paidId = playerPaymentsCharges[playerName][paymentId].paid;
          console.log("ASSIGNING PAYMENT TO MANUAL CHARGE", playerName, paymentId, paymentFrom, paidId);
          if (playerPaymentsCharges[paymentFrom]["payment_" + paidId]) {
            playerPaymentsCharges[paymentFrom]["payment_" + paidId].remainingAmount -= 4;
            console.log("... FOUND! ", paymentFrom, paidId, playerPaymentsCharges[paymentFrom]["payment_" + paidId].amount, playerPaymentsCharges[paymentFrom]["payment_" + paidId].remainingAmount);
            const playerLedgerDocRef = firestore.collection("CLOSED_LEDGER").doc(paymentFrom);
            var currentPlayerData = { paymentFrom: playerPaymentsCharges[paymentFrom]};
            playerLedgerDocRef.set(currentPlayerData, { merge: true });
          }
        }
      }
    }

  var playerAliasMaps = await getDefinedPlayerAliasMaps();
  var aliasToPlayerMap = playerAliasMaps["aliasToPlayerMap"];
  for (var monthNumber = 1; monthNumber < 10; monthNumber ++) {
    var gameMonth = String(monthNumber).padStart(2, '0');
    var gameYear = 2023;

    //var attendanceData = await queryDatabaseAndCalcGamesPlayedRatio(req.query.date, 12);

    // get the attendance data for this month
    var gameId = gameYear + "-" + gameMonth + "-01";
    var gamesCollectionId = "games_" + gameId;
    console.log('Setting month status to closed:', gamesCollectionId);
    const existingDoc = await firestore.collection(gamesCollectionId).doc("_attendance").get();
    var attendanceData = existingDoc.data();

    //console.log("ATTENDANCE!", attendanceData);
    // now request payment for all game attendance
    var mondaysDates = mondaysInMonth(Number(gameMonth), Number(gameYear));  //=> [ 7,14,21,28 ]
    for (var weekNumber = 0; weekNumber <= 5; weekNumber ++) {
      //console.log("week", weekNumber)
      var playerList = attendanceData[weekNumber];
      if (playerList) {
        Object.keys(playerList).forEach(await function(playerName) {
          // get the official name from the alias list
          var officialPlayerName = getOfficialNameFromAlias(playerName, aliasToPlayerMap);
          officialPlayerName = (officialPlayerName) ? officialPlayerName : playerName;
          // check a real player (not the scores) and that the player actually played
          if ((playerName != "scores") && (playerList[playerName] > 0)) {
            var gameWeek = gameId + "_" + weekNumber;

            //const playerLedgerDocRef = firestore.collection("PAYMENTS").doc(playerName);
            const playerLedgerDocRef = firestore.collection("CLOSED_LEDGER").doc(playerName);
            var gameDay = mondaysDates[weekNumber];
            if (gameDay < 10) {
              gameDay = "0" + gameDay;
            }
            var thisDate = gameYear + "-" + gameMonth + "-" + gameDay;
            var playerTransactionSavedata = {};
            var chargeId = "charge_" + thisDate;
            //playerTransactionSavedata[chargeId] = { "amount": (COST_PER_GAME * -1) };
            playerTransactionSavedata[chargeId] = {};
            playerTransactionSavedata[chargeId].amount = (COST_PER_GAME * -1);

            //////////////
            // NEED TO MATCH CORRESPONDING PAYMENT
            
          if (playerPaymentsCharges[playerName]) {
            // add in all of the payments
            Object.keys(playerPaymentsCharges[playerName]).sort().forEach(function(paymentId) {
              if (!foundPayment && paymentId.startsWith("payment_")) {
                playerTransactionSavedata[paymentId] = playerPaymentsCharges[playerName][paymentId];
                playerTransactionSavedata[paymentId].amount = Number(playerTransactionSavedata[paymentId].amount)
              }
            });
            // now assign the right charge to the payment
            var foundPayment = false;
            Object.keys(playerTransactionSavedata).sort().forEach(function(paymentId) {
              if (!foundPayment && paymentId.startsWith("payment_")) {
                var paymentAmount = Number(playerTransactionSavedata[paymentId].amount);
                var remainingAmount = Number(playerTransactionSavedata[paymentId].remainingAmount);
                if (remainingAmount >= 4) {
                  // enough remaining in this payment, so allocate the charge
                  remainingAmount -= 4;
                  //////////playerTransactionSavedata[paymentId].remainingAmount = remainingAmount;
                  //if (!playerPaymentsCharges[playerName][chargeId] || !playerPaymentsCharges[playerName][chargeId].paid) {
                    console.log(playerName, paymentId, chargeId, typeof remainingAmount);
                    //playerPaymentsCharges[playerName][chargeId].paid = paymentId;
                    //console.log("playerPaymentsCharges:", playerName, paymentId, paymentAmount, chargeId, remainingAmount);
                    foundPayment = true;
                    playerTransactionSavedata[chargeId].paid = playerTransactionSavedata[paymentId].paypalTransactionId;
                    playerTransactionSavedata[paymentId].remainingAmount = remainingAmount;
                  //}
                }
              }
            });
          }

            /**
            // read list of outstanding payments for the player
            const playerClosedLedgerDocRef = firestore.collection("CLOSED_LEDGER").doc(officialPlayerName);
            var playerTransactionName = "payment_" + thisDate + "_" + transactionId;
            var playerClosedLedgerDoc = await playerClosedLedgerDocRef.get();
            if (playerClosedLedgerDoc.data() && playerClosedLedgerDoc.data()[playerTransactionName]) {
              console.warn("transaction already exists, skipping to avoid double counting...", playerTransactionName);
              //res.send({'result': 'Already exists: ' + playerTransactionName});
              //return true;
            }
            */
            //var playerTransactionSavedata = {};
            //playerTransactionSavedata[playerTransactionName] = { "amount": amount, "paypalTransactionId": transactionId };
            //console.log('Adding PAYMENTS:', officialPlayerName, thisDate, JSON.stringify(playerTransactionSavedata));
            //playerClosedLedgerDocRef.set(playerTransactionSavedata, { merge: true });
            
            // transactionId = XXX
            // playerTransactionSavedata["charge_" + thisDate] = { "amount": (COST_PER_GAME * -1), "paid": transactionId};
            //////////////

            //console.log('Adding game cost:', playerName, thisDate, JSON.stringify(playerTransactionSavedata));
            playerLedgerDocRef.set(playerTransactionSavedata, { merge: true });
          }
        });
      }
    }
  }
}
////////////////////////
////////////////////////
////////////////////////

