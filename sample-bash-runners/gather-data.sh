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
  for month in {01..12}; do
    case $month in
      01|03|05|07|08|10|12)
        days=31
        ;;
      04|06|09|11)
        days=30
        ;;
      02)
        if (( (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) )); then
          days=29
        else
          days=28
        fi
        ;;
    esac
    start_date="$year-$month-01"
    end_date="$year-$month-$days"
    update_dates "$start_date" "$end_date"
    npm start
  done
done

# set to what I want the ending config state to be
update_dates "2023-09-01" "2024-09-01"