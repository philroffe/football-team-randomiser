# football-team-randomiser

A simple web application that:
- Downloads the public ical from doodle (hard-coded to the footie doodle account at present)
- Looks up the date of next Monday and locates the public doodle link
- Calls the doodle API to retrieve the players
- Randomises the players and generates the teams
- Auto generates the email text ready to send

It can be run locally, or deploys easily to heroku.

## Running Locally

Make sure you have [Node.js](http://nodejs.org/) and the [Heroku CLI](https://cli.heroku.com/) installed.

```sh
$ git clone https://github.com/philroffe/football-team-randomiser.git # or clone your own fork
$ cd football-team-randomiser
$ npm install
$ . .env-local
$ npm run restore
$ npm start
```

## Setting up for the very first time
Install node using nvm as described here https://github.com/nvm-sh/nvm

```sh
# if using Ubuntu, remove any old version of node
sudo apt remove nodejs
# install the new version
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.bashrc  # because get nvm on the PATH
nvm -v       # should say 0.40.1
nvm list-remote # gives a list of packages
# install the version you need (as shown is latest v20 at time of writing)
nvm install 20.18.1
```

Install the gcloud CLI as described here: https://cloud.google.com/sdk/docs/install#deb
```sh
sudo apt-get install apt-transport-https ca-certificates gnupg curl
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
sudo apt-get update && sudo apt-get install google-cloud-cli
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install google-cloud-cli
sudo apt install google-cloud-cli-firestore-emulator default-jre
```

```
# if this is the first time you've setup/run the google cloud tools, initialise it with...
gcloud auth login
gcloud auth application-default login
gcloud config set project tensile-spirit-360708

# start the emulator (ideally in another terminal)
gcloud beta emulators firestore start --host-port="0.0.0.0:5678"

# restore config and backup files
# (or setup .env-local and .env-local-prod from scratch using the included .env file)
cp ~/football-team-randomiser-backup/.env-local .
cp ~/football-team-randomiser-backup/.env-local-prod .
cp ~/football-team-randomiser-backup/keyfile.json .
cp ~/football-team-randomiser-backup/backups/ .

# now restore the database locally and start the app
. .env-local
npm run restore
npm start
```

Your app should now be running on [localhost:5000](http://localhost:5000/).

You will need to setup an GMAIL App Password to allow you to authenicate to send email on behalf of the footie admin.  Follow instructions here:
https://support.google.com/accounts/answer/185833?hl=en
 - see "Create & use app passwords"
 - set env vars GOOGLE_MAIL_USERNAME and GOOGLE_MAIL_APP_PASSWORDs


## Running the JEST tests
```
 npm test
```

## Deploying to Google Cloud App Engine



Now deploy the app...
```
gcloud app deploy .app-prod.yaml
# if you get a build error (e.g. after deleting old files from storage), run with --no-cache 
#ERROR: failed to initialize analyzer: getting previous image: getting config file for image... unexpected status code 404 Not Found:
gcloud app deploy .app-prod.yaml--no-cache

# if you want a weekly scheduled task then deploy the cron too...
gcloud app deploy cron.yaml
```
```
# you can clean up old deployments using this command (deletes everything except the latest 3)
gcloud app versions list --format="value(version.id)" --sort-by="~version.createTime" | tail -n +4 | xargs -r gcloud app versions delete
```

## Setting up Google Cloud App Engine and Firebase

```
# setup backup schedules
# https://cloud.google.com/firestore/docs/backups
gcloud alpha firestore backups schedules create --database="(default)" --recurrence=daily --retention=3d
gcloud alpha firestore backups schedules create --database="(default)" --recurrence=weekly --retention=5w --day-of-week=tuesday
# list backup schedules and backups
gcloud alpha firestore backups schedules list --database="(default)"
gcloud alpha firestore backups list --format="table(name, database, state)"
```

## Run firebase emulator locally

```
sudo apt-get install google-cloud-cli-firestore-emulator
gcloud beta emulators firestore start --host-port="0.0.0.0:5678"

export FIRESTORE_EMULATOR_HOST=0.0.0.0:5678
npm start

```

```
# to backup production...
unset FIRESTORE_EMULATOR_HOST
npm run backup

# to restore backup to emulator...
export FIRESTORE_EMULATOR_HOST=0.0.0.0:5678
npm run restore <db-backup-filename>

```

## Originally Forked from node-js-getting-started as a base template

From this tutorial...
https://devcenter.heroku.com/articles/getting-started-with-nodejs#deploy-the-app

## Documentation

For more information about using Node.js on Google Cloud, see these Dev Center articles:

- [Deploying Your Node.js app on Google App Engine](https://cloud.google.com/appengine/docs/standard/nodejs/building-app/deploying-web-service)

