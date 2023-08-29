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
$ npm start
```

Your app should now be running on [localhost:5000](http://localhost:5000/).

You will need to setup an GMAIL App Password to allow you to authenicate to send email on behalf of the footie admin.  Follow instructions here:
https://support.google.com/accounts/answer/185833?hl=en
 - see "Create & use app passwords"
 - set env vars GOOGLE_MAIL_USERNAME and GOOGLE_MAIL_APP_PASSWORDs


## Deploying to Google Cloud App Engine

Install the gcloud CLI as described here: https://cloud.google.com/sdk/docs/install#deb

```
gcloud app deploy .app-prod.yaml
```

## Setting up Google Cloud App Engine and Firebase

```
# setup backup schedules
# https://cloud.google.com/firestore/docs/backups
gcloud alpha firestore backups schedules create --database "(default)" --recurrence=daily --retention=3
gcloud alpha firestore backups schedules create --database "(default)" --recurrence=weekly --retention=5 --day-of-week=tuesday
# list backup schedules and backups
gcloud alpha firestore backups schedules list --database "(default)"
gcloud alpha firestore backups list --format="table(name, database, state)"
```

## Originally Forked from node-js-getting-started as a base template

From this tutorial...
https://devcenter.heroku.com/articles/getting-started-with-nodejs#deploy-the-app

## Documentation

For more information about using Node.js on Google Cloud, see these Dev Center articles:

- [Deploying Your Node.js app on Google App Engine](https://cloud.google.com/appengine/docs/standard/nodejs/building-app/deploying-web-service)

