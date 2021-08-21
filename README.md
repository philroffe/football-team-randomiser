# football-team-randomiser

A simple web application that:
- Downloads the public ical from doodle (hard-coded to the footie doodle account at present)
- Looks up the date of next Monday and locates the public doodle link
- Calls the doodle API to retrieve the players
- Randomises the players and generates the teams
- Auto generates the email text ready to send

It can be run locally, or deploys easily to heroku.

## Forked from node-js-getting-started as a base template

From this tutorial...
https://devcenter.heroku.com/articles/getting-started-with-nodejs#deploy-the-app

A barebones Node.js app using [Express 4](http://expressjs.com/).

## Running Locally

Make sure you have [Node.js](http://nodejs.org/) and the [Heroku CLI](https://cli.heroku.com/) installed.

```sh
$ git clone https://github.com/philroffe/football-team-randomiser.git # or clone your own fork
$ cd football-team-randomiser
$ npm install
$ npm start
```

Your app should now be running on [localhost:5000](http://localhost:5000/).

## Deploying to Heroku

```
$ heroku create
$ git push heroku main
$ heroku open
```
or

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.png)](https://heroku.com/deploy)

## Documentation

For more information about using Node.js on Heroku, see these Dev Center articles:

- [Getting Started on Heroku with Node.js](https://devcenter.heroku.com/articles/getting-started-with-nodejs)
- [Heroku Node.js Support](https://devcenter.heroku.com/articles/nodejs-support)
- [Node.js on Heroku](https://devcenter.heroku.com/categories/nodejs)
- [Best Practices for Node.js Development](https://devcenter.heroku.com/articles/node-best-practices)
- [Using WebSockets on Heroku with Node.js](https://devcenter.heroku.com/articles/node-websockets)
