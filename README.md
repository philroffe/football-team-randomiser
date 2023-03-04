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

## Deploying to Google Cloud App Engine

```
gcloud app deploy --env-vars-file .env-prod.yaml
```

## Originally Forked from node-js-getting-started as a base template

From this tutorial...
https://devcenter.heroku.com/articles/getting-started-with-nodejs#deploy-the-app

## Documentation

For more information about using Node.js on Heroku, see these Dev Center articles:

- [Deploying Your Node.js app on Google App Engine](https://cloud.google.com/appengine/docs/standard/nodejs/building-app/deploying-web-service)

