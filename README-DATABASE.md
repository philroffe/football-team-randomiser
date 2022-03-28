CREATE ROLE footballdbrole;
ALTER ROLE footballdbrole WITH LOGIN PASSWORD 'footballdbrole' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE football OWNER footballdbrole;
REVOKE ALL ON DATABASE football FROM PUBLIC;
GRANT CONNECT ON DATABASE football TO footballdbrole;
GRANT ALL ON DATABASE football TO footballdbrole;


CREATE TABLE games (
     gameid      char(10) PRIMARY KEY,
     last_updated  TIMESTAMP DEFAULT NOW(),
     gamedetails jsonb NOT NULL
);

CREATE TABLE game_history (
     id          serial PRIMARY KEY,
     gameid      char(10),
     last_updated  TIMESTAMP DEFAULT NOW(),
     source_ip  inet,
     gamedetails_pre jsonb NOT NULL,
     gamedetails_new jsonb NOT NULL,
     gamedetails_merged jsonb NOT NULL,
     gamedetails_diff jsonb
);
