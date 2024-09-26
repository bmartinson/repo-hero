#!/bin/bash

# Function to update the config.json file
update_dates() {
  local start_date=$1
  local end_date=$2
  jq --arg start_date "$start_date" --arg end_date "$end_date" \
    '.startDate = $start_date | .endDate = $end_date' config.json > temp.json && mv temp.json config.json
}

start_year=$1
end_year=$2

for year in $(seq $start_year $end_year); do
  update_dates "$year-01-01" "$year-01-31"
  npm start
  if (( (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) )); then
    update_dates "$year-02-01" "$year-02-29"
    npm start
  else
    update_dates "$year-02-01" "$year-02-28"
    npm start
  fi
  update_dates "$year-03-01" "$year-03-31"
  npm start
  update_dates "$year-04-01" "$year-04-30"
  npm start
  update_dates "$year-05-01" "$year-05-31"
  npm start
  update_dates "$year-06-01" "$year-06-30"
  npm start
  update_dates "$year-07-01" "$year-07-31"
  npm start
  update_dates "$year-08-01" "$year-08-31"
  npm start
  update_dates "$year-09-01" "$year-09-30"
  npm start
  update_dates "$year-10-01" "$year-10-31"
  npm start
  update_dates "$year-11-01" "$year-11-30"
  npm start
  update_dates "$year-12-01" "$year-12-31"
  npm start
done

# set to what I want the ending config state to be
update_dates "2023-09-01" "2024-09-01"