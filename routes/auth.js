const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20');
const teamUtils = require("../views/pages/generate-teams-utils.js");

const GOOGLE_CALLBACK_URL = (process.env.GOOGLE_CALLBACK_URL) ? process.env.GOOGLE_CALLBACK_URL : "http://localhost:5000/auth/google/callback";
const ALLOWED_ADMIN_EMAIL_ADDRS = (process.env.ALLOWED_ADMIN_EMAIL_ADDRS) ? process.env.ALLOWED_ADMIN_EMAIL_ADDRS : "philroffe@gmail.com";
const EMAIL_TYPE_ALL_PLAYERS = 0;
const EMAIL_TYPE_ADMIN_ONLY = 1;
const EMAIL_TYPE_TEAMS_ADMIN = 2;

// Configure the Google strategy for use by Passport.
//
// OAuth 2.0-based strategies require a `verify` function which receives the
// credential (`accessToken`) for accessing the Facebook API on the user's
// behalf, along with the user's profile.  The function must invoke `cb`
// with a user object, which will be set at `req.user` in route handlers after
// authentication.

passport.use(new GoogleStrategy({
  clientID: process.env['GOOGLE_CLIENT_ID'],
  clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
  callbackURL: GOOGLE_CALLBACK_URL,
  scope: [ 'profile', 'email' ],
  state: true
},
  function verify(accessToken, refreshToken, profile, cb) {
  //console.log(profile);
  var user;
  if (profile) {
    var allowedUsers = ALLOWED_ADMIN_EMAIL_ADDRS.split(",");
    var profileEmail = profile.emails[0].value;
    if (allowedUsers.includes(profileEmail)) {
      user = {
        id: profile.id,
        name: profile.displayName,
        email: profileEmail
      };
    } else {
      user = undefined;
      console.warn("WARNING: Denied attempt to login from unknown user: ", profile);
      teamUtils.sendAdminEvent(EMAIL_TYPE_ADMIN_ONLY, "WARNING: Denied attempt to login from unknown user:", JSON.stringify(profile.emails[0].value));
    }
  }
  return(cb(null, user));
}));
  
// Configure Passport authenticated session persistence.
//
// In order to restore authentication state across HTTP requests, Passport needs
// to serialize users into and deserialize users out of the session.  In a
// production-quality application, this would typically be as simple as
// supplying the user ID when serializing, and querying the user record by ID
// from the database when deserializing.  However, due to the fact that this
// example does not have a database, the complete Facebook profile is serialized
// and deserialized.
passport.serializeUser(function(user, cb) {
  process.nextTick(function() {
    cb(null, { id: user.id, username: user.username, name: user.name, email: user.email });
  });
});

passport.deserializeUser(function(user, cb) {
  process.nextTick(function() {
    return cb(null, user);
  });
});


var router = express.Router();

/* GET /login/federated/accounts.google.com
 *
 * This route redirects the user to Google, where they will authenticate.
 *
 * Signing in with Google is implemented using OAuth 2.0.  This route initiates
 * an OAuth 2.0 flow by redirecting the user to Google's identity server at
 * 'https://accounts.google.com'.  Once there, Google will authenticate the user
 * and obtain their consent to release identity information to this app.
 *
 * Once Google has completed their interaction with the user, the user will be
 * redirected back to the app at `GET /oauth2/redirect/accounts.google.com`.
 */
router.get('/login/federated/google', passport.authenticate('google', { scope : ['email', 'profile'] }));

/*
    This route completes the authentication sequence when Google redirects the
    user back to the application.  When a new user signs in, a user account is
    automatically created and their Google account is linked.  When an existing
    user returns, they are signed in to their linked account.
*/
router.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/error', failureMessage: true }),
  function(req, res) {
    res.redirect('/loggedin');
  });
/* GET /logout
 *
 * This route logs the user out.
 */
router.get('/logout', function(req, res, next) {
  req.logout(function(err) {
    if (err) { return next(err); }
    res.redirect('/');
  });
});

module.exports = router;
