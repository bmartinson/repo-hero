#!/bin/bash

# Function to update the config.json file
update_dates() {
  local start_date=$1
  local end_date=$2
  jq --arg start_date "$start_date" --arg end_date "$end_date" \
    '.startDate = $start_date | .endDate = $end_date' config.json > temp.json && mv temp.json config.json
}

update_dates "2022-12-01" "2022-12-31"
npm start
update_dates "2023-01-01" "2023-01-31"
npm start
update_dates "2023-02-01" "2023-02-28"
npm start
update_dates "2023-03-01" "2023-03-31"
npm start
update_dates "2023-04-01" "2023-04-30"
npm start
update_dates "2023-05-01" "2023-05-31"
npm start
update_dates "2023-06-01" "2023-06-30"
npm start
update_dates "2023-07-01" "2023-07-31"
npm start
update_dates "2023-08-01" "2023-08-31"
npm start
update_dates "2023-09-01" "2023-09-30"
npm start
update_dates "2023-10-01" "2023-10-31"
npm start
update_dates "2023-11-01" "2023-11-30"
npm start
update_dates "2023-12-01" "2023-12-31"
npm start

update_dates "2024-01-01" "2024-01-31"
npm start
update_dates "2024-02-01" "2024-02-28"
npm start
update_dates "2024-03-01" "2024-03-31"
npm start
update_dates "2024-04-01" "2024-04-30"
npm start
update_dates "2024-05-01" "2024-05-31"
npm start
update_dates "2024-06-01" "2024-06-30"
npm start
update_dates "2024-07-01" "2024-07-31"
npm start
update_dates "2024-08-01" "2024-08-31"
npm start
update_dates "2024-09-01" "2024-09-30"
npm start

# set to what I want the ending config state to be
update_dates "2023-09-01" "2024-09-01"