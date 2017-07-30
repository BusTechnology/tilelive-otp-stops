"use strict"
const geojsonVt = require('geojson-vt');
const vtPbf = require('vt-pbf');
const request = require('requestretry');
const zlib = require('zlib');
const _ = require('lodash')

var res = "";
function updateRes(){ res = (new Date()).toISOString().slice(0,10).replace(/-/g,"") };

Array.prototype.flatMap = function(lambda) {
  return [].concat.apply([],this.map(lambda));
};

Array.prototype.uniq = function() {
  return _.uniqWith(this, _.isEqual)
}

const getTileIndex = (url, query, map, callback) => {
  console.log(url);
  console.log(query);

  request({
    url: url,
    body: query,
    maxAttempts: 120,
    retryDelay: 1800000,
    method: 'POST',
    headers: {
      'Content-Type': 'application/graphql',
      'OTPTimeout': '60000',
      'OTPMaxResolves': '100000000'
    }
  }, function (err, res, body){
    if (err){
      console.log(err)
      callback(err);
      return;
    }
    callback(null, geojsonVt(map(JSON.parse(body)), {
      maxZoom: 20,
      buffer: 1024,
    })); //TODO: this should be configurable)
  })
}

function getStopQuery() { return `
  query stops {
    stops{
      gtfsId
      name
      code
      platformCode
      lat
      lon
      locationType
      topDestinationsForToday(serviceDay: "${res}") {
        route {
          mode
          shortName
          color
        }
        headsign
      }
      parentStation {
        gtfsId
      }
      patterns {
        headsign
        route {
          mode
          color
          shortName
        }
      }
    }
  }
`;}

function getStationQuery() { return `
  query stations{
    stations{
      gtfsId
      name
      lat
      lon
      locationType
      stops {
        gtfsId
        topDestinationsForToday(serviceDay: "${res}"){
        route {
          mode
          shortName
          color
        }
        headsign
      }
        patterns {
          route {
            mode
            color
            shortName
          }
        }
      }
    }
  }
`;}

const stopMapper = data => ({
  type: "FeatureCollection",
  features: data.data.stops.map(stop => ({
    type: "Feature",
    geometry: {type: "Point", coordinates: [stop.lon, stop.lat]},
    properties: {
      gtfsId: stop.gtfsId,
      name: stop.name,
      code: stop.code,
      platform: stop.platformCode,
      parentStation: stop.parentStation == null ? null : stop.parentStation.gtfsId,
      type: stop.topDestinationsForToday == null ? null : stop.topDestinationsForToday.map(destination => destination.route.mode).uniq().join(","),
      patterns: stop.topDestinationsForToday == null ? null : JSON.stringify(stop.topDestinationsForToday.map(destination => ({
        color: destination.route.color,
        headsign: destination.headsign,
        type: destination.route.mode,
        shortName: destination.route.shortName,
      })))
    }
  }))
})

const stationMapper = data => ({
  type: "FeatureCollection",
  features: data.data.stations.map(station => ({
    type: "Feature",
    geometry: {type: "Point", coordinates: [station.lon, station.lat]},
    properties: {
      gtfsId: station.gtfsId,
      name: station.name,
      type: Array.from(new Set(station.stops.flatMap(stop => stop.topDestinationsForToday.flatMap(destination => destination.route.mode)))).join(','),
      stops: JSON.stringify(station.stops.map(stop => stop.gtfsId)),
      routes: JSON.stringify(station.stops.flatMap(stop => stop.topDestinationsForToday.flatMap(destination => destination.route)).uniq()),
    }
  }))
})


class GeoJSONSource {
  connect(uri, callback){
    updateRes();
    console.log(`Running update with res ${res}`);
    uri.protocol = "http:"
    getTileIndex(uri, getStopQuery(), stopMapper, (err, stopTileIndex) => {
      if (err){
        callback(err);
        return;
      }
      this.stopTileIndex = stopTileIndex;
      getTileIndex(uri, getStationQuery(), stationMapper, (err, stationTileIndex) => {
        if (err){
          callback(err);
          return;
        }
        this.stationTileIndex = stationTileIndex;
        console.log("stops loaded")
        callback(null, this);
      })
    })
  };

  constructor(uri, callback){
    this.connect(uri, callback);
    //roughly every hour, execute this function so we can update the stops...
    setTimeout(this.connect,3600000,uri,callback);
  };

  getTile(z, x, y, callback){
    let stopTile = this.stopTileIndex.getTile(z, x, y)
    let stationTile = this.stationTileIndex.getTile(z, x, y)

    if (stopTile === null){
      stopTile = {features: []}
    }

    if (stationTile === null){
      stationTile = {features: []}
    }

    zlib.gzip(vtPbf.fromGeojsonVt({stops: stopTile, stations: stationTile}), function (err, buffer) {
      if (err){
        callback(err);
        return;
      }

      callback(null, buffer, {"content-encoding": "gzip"})
    })
  }

  getInfo(callback){
    callback(null, {
      format: "pbf",
      maxzoom: 20,
      minzoom: 0,
      vector_layers: [{
        description: "",
        id: "stops"
      },
      {
        description: "",
        id: "stations"
      }]
    })
  }
}

module.exports = GeoJSONSource

module.exports.registerProtocols = (tilelive) => {
  tilelive.protocols['otpstops:'] = GeoJSONSource
}
