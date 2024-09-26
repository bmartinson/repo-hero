#!/bin/bash

# Function to update the config.json file
update_dates() {
  local start_date=$1
  local end_date=$2
  jq --arg start_date "$start_date" --arg end_date "$end_date" \
    '.startDate = $start_date | .endDate = $end_date' config.json > temp.json && mv temp.json config.json
}

update_dates "2019-01-01" "2019-01-31"
npm start
update_dates "2019-02-01" "2019-02-28"
npm start
update_dates "2019-03-01" "2019-03-31"
npm start
update_dates "2019-04-01" "2019-04-30"
npm start
update_dates "2019-05-01" "2019-05-31"
npm start
update_dates "2019-06-01" "2019-06-30"
npm start
update_dates "2019-07-01" "2019-07-31"
npm start
update_dates "2019-08-01" "2019-08-31"
npm start
update_dates "2019-09-01" "2019-09-30"
npm start
update_dates "2019-10-01" "2019-10-31"
npm start
update_dates "2019-11-01" "2019-11-30"
npm start
update_dates "2019-12-01" "2019-12-31"
npm start

# set to what I want the ending config state to be
update_dates "2023-09-01" "2024-09-01"