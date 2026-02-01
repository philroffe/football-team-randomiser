#!/bin/bash

OPTION=$1

. .env-local
DB_PID=`ps -ef | grep "CloudFirestore start" | grep -v grep | awk '{print $2}'`

if [ "$OPTION" = "stop" ] ; then
  if [ "$DB_PID" != "" ] ; then
    kill `echo $DB_PID`
    echo "Stopped database"
  else
    echo "DB not running"
  fi
  exit 0
fi


# start the database
if [ "$DB_PID" == "" ] ; then
  echo "Starting database..."
  gcloud beta emulators firestore start --host-port="0.0.0.0:5678" &
  counter=0
  until [ "$CURL" == "Ok" ] ; do
    CURL=`curl -s -L http://localhost:5678`
    echo "Counter: $counter ${CURL}"
    sleep 1
    if [ $counter = 10 ] ; then
      echo "ERROR starting database.  Giving up"
      exit
    fi
    ((counter++))
  done
  # restore the database from the latest backup
  npm run restore
else
  echo "DB already running..."
fi

# now start node.js app
npm start
