CREATE ROLE footballdbrole;
ALTER ROLE footballdbrole WITH LOGIN PASSWORD 'footballdbrole' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE football OWNER footballdbrole;
REVOKE ALL ON DATABASE football FROM PUBLIC;
GRANT CONNECT ON DATABASE football TO footballdbrole;
GRANT ALL ON DATABASE football TO footballdbrole;


CREATE TABLE games (
     gameid      char(10) PRIMARY KEY,
     created_at  TIMESTAMP DEFAULT NOW(),
     gamedetails jsonb NOT NULL
);

CREATE TABLE history (
     id          serial PRIMARY KEY,
     gameid      char(10),
     created_at  TIMESTAMP DEFAULT NOW(),
     changed_by  char(10),
     ip_address  inet,
     gamedetails jsonb NOT NULL
);
