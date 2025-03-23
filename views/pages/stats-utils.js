<script type="text/javascript">
  function createPlayerTicker() {
    var playerCountMap = {};
    var dataTicker = [];
    var weekCount = 0;
    // loop through all of the costs and payments for this year
    for (const collectionId in allCollectionDocs) {
      if (collectionId.startsWith("games_")) {
        var currentAttendance = allCollectionDocs[collectionId];
        //console.log("--", collectionId, currentAttendance);
        // loop through all docs
        for (const docId in allCollectionDocs[collectionId]) {
          var docName = allCollectionDocs[collectionId][docId].id;
          if (docName == "_attendance") {
            var docData = allCollectionDocs[collectionId][docId].data;
            // loop through scores of each week
            for (var weekNumber = 0; weekNumber <= 5; weekNumber ++) {
              var attendanceData = docData[weekNumber];
              if (attendanceData && Object.keys(attendanceData).length > 0) {
                //console.log("----", collectionId, weekNumber, attendanceData);
                weekCount++;
                for (var i = 0; i < playerNameSuggestions.length; i++) {
                  weekPlayerName = playerNameSuggestions[i];
                  if (weekPlayerName != "scores") {
                    var officialName = getOfficialNameFromAlias(weekPlayerName.replace(/<br>/g,''), aliasToPlayerMap);
                    if (officialName) {
                      var playerMap = playerCountMap[officialName];
                      if (!playerMap) {
                        playerMap = {};
                        playerMap.totalGames = 0;
                        playerMap.playerName = officialName;
                      }
                      var playerTeamNumber = attendanceData.players[weekPlayerName];
                      if (playerTeamNumber) {
                        // this player played
                        playerMap.totalGames = playerMap.totalGames + 1;
                        playerCountMap[officialName] = playerMap;
                      }
                      // now add data for the ticker
                      playerCumulativeGames = playerMap.totalGames;
                      var dateString = collectionId.replace(/games_/g, '');
                      var yearString = dateString.replace(/-.*/, '')
                      var monthString = monthShortDateFormat.format(new Date(dateString));

                      mondaysDates = mondaysInMonth(dateString.split("-")[1], yearString);  //=> [ 7,14,21,28 ]
      
                      var title = mondaysDates[weekNumber] + "-" + monthString + "-" + yearString + "  # Games:" + weekCount;
                      dataTicker.push([playerCumulativeGames, 0, 0, officialName, title]);
                      //console.log("------", playerCumulativeGames, officialName, title);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    //console.log("DATA", dataTicker);
    console.log("Total # games:", weekCount)

    var myTickerChart = echarts.init(document.getElementById('playerTickerDiv'), null, {
      renderer: 'canvas',
      useDirtyRect: false
    });

    const updateFrequency = 200;
    const dimension = 0;
    const playerColors = {};
    // generate some random colour for each player
    for (const playerName in playerCountMap) {
      var randomColor = Math.floor(Math.random()*16777215).toString(16);
      playerColors[playerName] = "#" + randomColor;
    }

    const years = [];
    for (let i = 0; i < dataTicker.length; ++i) {
      if (years.length === 0 || years[years.length - 1] !== dataTicker[i][4]) {
        years.push(dataTicker[i][4]);
      }
    }
    let startIndex = -1;
    let startYear = years[startIndex];
    var option;
    option = {
      grid: {
        top: 50,
        bottom: 10,
        left: 100,
        right: 50
      },
      xAxis: {
        max: 'dataMax',
        axisLabel: {
          formatter: function (n) {
            return Math.round(n) + '';
          }
        }
      },
      dataset: {
        source: dataTicker.slice(1).filter(function (d) {
          return d[4] === startYear;
        })
      },
      yAxis: {
        type: 'category',
        inverse: true,
        max: 30,
        axisLabel: {
          show: true,
          fontSize: 14,
          formatter: function (value) {
            return value;
          },
          rich: {
            flag: {
              fontSize: 25,
              padding: 5
            }
          }
        },
        animationDuration: 300,
        animationDurationUpdate: 300
      },
      series: [
        {
          realtimeSort: true,
          seriesLayoutBy: 'column',
          type: 'bar',
          itemStyle: {
            color: function (param) {
              return playerColors[param.value[3]] || 'lightblue';
            }
          },
          encode: {
            x: dimension,
            y: 3
          },
          label: {
            show: true,
            precision: 0,
            position: 'right',
            valueAnimation: true,
            fontFamily: 'monospace'
          }
        }
      ],
      // Disable init animation.
      animationDuration: 0,
      animationDurationUpdate: updateFrequency,
      animationEasing: 'linear',
      animationEasingUpdate: 'linear',
      graphic: {
        elements: [
          {
            type: 'text',
            right: 50,
            top: 20,
            style: {
              text: startYear,
              font: 'bolder 20px monospace',
              fill: 'rgba(100, 100, 100, 0.25)'
            },
            z: 100
          }
        ]
      }
    };
    // console.log(option);
    myTickerChart.setOption(option);
    for (let i = startIndex; i < years.length - 1; ++i) {
      (function (i) {
        setTimeout(function () {
          updateYear(years[i + 1]);
        }, (i - startIndex) * updateFrequency);
      })(i);
    }
    function updateYear(year) {
      let source = dataTicker.slice(1).filter(function (d) {
        return d[4] === year;
      });
      option.series[0].data = source;
      option.graphic.elements[0].style.text = year;
      myTickerChart.setOption(option);
    }
  }

  function mondaysInMonth(m,y) {
    var lastDateOfMonth = new Date(y,m,0).getDate();
    var firstDayNumberOfMonth =  new Date(m +'/01/'+ y).getDay(); // 0=Sun, 1=Mon...

    // check what day the 1st of the month is, and then calc the date of the next Monday
    var mondayDate;
    if (firstDayNumberOfMonth == 1) {
      // already a Monday (1st of the month)
      mondayDate = 1;
    } else if (firstDayNumberOfMonth == 0) {
      // it's a Sunday, so Monday is 1 day away (2nd of the month)
      mondayDate = 2;
    } else {
      // must be Tues-Sat so subtract from 9 (because max 7 days from )
      var mondayDate = 7 - (firstDayNumberOfMonth - 2);
    }

    // now loop through every 7 days and form an array of Monday dates
    var mondays = [];
    for (var i = mondayDate; i <= lastDateOfMonth; i += 7) {
      mondays.push(i);
    }

    //console.log("First Monday of month:", new Date(m +'/0' + mondays[0] + '/'+ y));
    //console.log("Mondays in the month:", mondays);
    return mondays;
  }
</script>
