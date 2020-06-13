var https = require('https'),
    fs = require('fs'),
    path = require('path'),
    filePath = path.join(__dirname, 'conf'),
    format = require('string.format'),
    winston = require('winston'),
    sendMail = require('gmail-send'),
    dotenv = require('dotenv');
    require('winston-daily-rotate-file');

var initLogs = function(conf){
	var transports = [ new winston.transports.Console(conf.console) ];
    if (conf.log.info.isEnabled) {
        transports.push(new (winston.transports.DailyRotateFile)({
            "level": conf.log.info.level,
            "timestamp": winston.format.timestamp(),
            "dirname": conf.log.info.dirname,
            "filename": conf.log.info.filename,
            "datePattern": conf.log.info.datePattern,
            "zippedArchive": false,
            "json": false
        }));
	}
	
    if (conf.log.error.isEnabled) {
        //TODO: Improvement find suitable implementation to rotate error logs
        transports.push(new winston.transports.File({ "level": conf.log.error.level, "filename": conf.log.error.dirname + '/' + conf.log.error.filename, timestamp: winston.format.timestamp(), "json": false }));
	}
	
	var logger = winston.createLogger({
		level: conf.log.level,
		format: winston.format.printf(info => `${new Date().toString()} : ${info.message}`), //winston.format.combine(winston.format.timestamp().timestamp, winston.format.simple()),
		transports: transports,
		exitOnError: false, // do not exit on handled exceptions
	});
	
	return logger;
};

var appInit = function(conf, afterInit, logger) {
	logger.info('Reading row template file.');
	fs.readFile(conf.rowTemplatePath, { encoding: 'utf-8' }, function (err, data) {
		if (!err) {
			var templateContent = data;
			logger.info('Row template file read successfully.');
			
			logger.info('Initializing mailer.');
			var mailer = sendMail(conf.mailOptions);
			logger.info('Mailer initialization successful.');
			
			logger.info('Initializing commodity monitor.');
			afterInit(conf, mailer, templateContent, logger);
		} else {
			logger.error('Error in reading template file.' + err);
		}
	});
};

var formatMailContent = function(templateContent, details, promises, results, conf, logger) {
	logger.info('Formatting header');
	
	var headerRow = {
		commodity:  conf.templateHeaders[0],
		exchange: conf.templateHeaders[1],
		currentPrice: conf.templateHeaders[2],
		change: conf.templateHeaders[3],
		direction: '',
		percentchange: '',
		openingPrice: conf.templateHeaders[4],
		lastAvailablePrice: conf.templateHeaders[5],
		yearlylow: conf.templateHeaders[6],
		yearlyhigh: conf.templateHeaders[7]
	};
	var rowHeader = templateContent.format(headerRow);
	
	var niftyContent = '';
	if (details) {
		niftyContent = templateContent.format(details);	
	}
	
	var stockContent = '';
	for(var i=0;i<promises.length;i++) {
		logger.info(promises[i].name + ': Formatting mail content.');
		stockContent = stockContent + templateContent.format(results[i]);
	}
	
	var mailContent = conf.containerTemplate.format({ rowTemplate: rowHeader + niftyContent + stockContent });
	logger.info('Mail content formatted.');
	
	return mailContent;
};

var canStartPolling = function () {
    var currentDateTimeInMs = new Date();

    if (!conf.pollingStartTimeAsDate) {
        var pollingStartTime = new Date(currentDateTimeInMs.getTime());
        var startTimeConf = conf.pollingStartTime.split(':');
        pollingStartTime.setHours(Number(startTimeConf[0]), Number(startTimeConf[1]), Number(startTimeConf[2]));
        conf.pollingStartTimeAsDate = pollingStartTime;
    }

    if (!conf.pollingEndTimeAsDate) {
        var pollingEndTime = new Date(currentDateTimeInMs.getTime());
        var endTimeConf = conf.pollingEndTime.split(':');
        pollingEndTime.setHours(Number(endTimeConf[0]), Number(endTimeConf[1]), Number(endTimeConf[2]));
        conf.pollingEndTimeAsDate = pollingEndTime;
    }

    var currentDateTimeInMs = currentDateTimeInMs.getTime();
    var pollingStartTimeInMs = conf.pollingStartTimeAsDate.getTime();
    var pollingEndTimeInMs = conf.pollingEndTimeAsDate.getTime();

    return currentDateTimeInMs > pollingStartTimeInMs && currentDateTimeInMs < pollingEndTimeInMs;
}

var monitorFeed = function(conf, mailer, templateContent, logger) {
	var intervalObj = null;
    try {
        intervalObj = setInterval(() => {
            if (canStartPolling()) {
                requestCommodityFeed(mailer, templateContent, conf, logger);
            }
		}, conf.pollIntervalInMs);
	} catch(e) {
		logger.error('Error while triggering poll: ' + e);
		if(intervalObj)
		{
			intervalObj();
		}
	}
}

var getStockPrice = function(stock, conf, logger) {
	return new Promise((resolve, reject) => {
		var queryUrl = conf.queryUrl.format(stock);
		logger.info(stock.name + ': Retrieving NAV details.');
		https.get(queryUrl, res => {
			res.on('data', (data) => {
				logger.info(stock.name + ': Query feed response received.');
				var response = JSON.parse(data);
				var result = response.filter(function(x){
					return x.pdt_dis_nm.indexOf(', '+ stock.name + ',') > -1;
				});
			
				if(result.length > 0) {
					logger.info(stock.name + ': Price feed exists for the stock.');
					var feedUrl = conf.stockPriceFeedUrl.format({code: result[0].sc_id});
					logger.info(stock.name + ': Building price feed url.');
					https.get(feedUrl, feedres => {
						var feedResponseData = '';
						feedres.on('data', (chunk) => {
							feedResponseData = feedResponseData + chunk;
						});
						
						feedres.on('end', () => {
							var feedResponse = JSON.parse(feedResponseData);
							logger.info(stock.name + ': Price feed response received.');
							var output = {
								commodity:  stock.name,
								exchange: feedResponse.data.exchange,
								currentPrice: feedResponse.data.pricecurrent,
								change: feedResponse.data.pricechange,
								direction: feedResponse.data.ty,
								percentchange: feedResponse.data.pricepercentchange,
								openingPrice: feedResponse.data.OPN,
								lastAvailablePrice: feedResponse.data.priceprevclose,
								yearlylow: feedResponse.data['52L'],
								yearlyhigh: feedResponse.data['52H']
							};
							
							var data = "{commodity} : {currentPrice} ({lastAvailablePrice} {percentchange}'%') / Opening Price: {openingPrice} / 52 Weeks Low-High: {yearlylow}-{yearlyhigh}";
							logger.info(stock.name + ': Data - ' + data.format(output));
							// pricechange: "530.2500"
							// pricecurrent: "11487.90"
							// pricepercentchange: "4.8391"
							// priceprevclose: "10957.65"
							// OPN: "11100.00"
							// ty: "1"
							// 52H: "17679.85"
							// 52L: "7850.00"					
							resolve(output);
						});
					});
				}
			});
        });
	});
};

var isOutsideThreshold = function(data, conf, logger) {
	var priceDiff = Number(data.currentPrice) - Number(data.openingPrice);
	var priceDiffInPercent = (priceDiff / Number(data.openingPrice)) * 100;
	if(Number(data.percentchange) < conf.triggerThreshold) {
		logger.info(data.commodity + ': Percentage change is outside threshold (from LAST AVAILABLE PRICE).');
		return true;
	} else if(priceDiffInPercent < conf.triggerThreshold) {
		logger.info(data.commodity + ': Percentage change is outside threshold (from OPENING PRICE).');
		return true;
	}
	
	logger.info(data.commodity + ': Parameters with-in threshold.');
	return false;
}

var individualStockWatch = function(send, templateContent, conf, logger){
	logger.info('Requesting for indivual stock data.')
	var promises = [];
	for(var i=0;i<conf.stocks.length;i++) {
		var promise = getStockPrice(conf.stocks[i], conf, logger);
		promises.push({ name: conf.stocks[i].name, promise: promise });
	}
	
	var stockPromises = promises.map(function(x) {
		return x.promise;
	});
	
	logger.info('Requesting for indivual stock data.');
	Promise.all(stockPromises).then(function(results){
		logger.info('Indivual stock data retrieved.');
		
		logger.info('Performing threshold check');
		var filteredPromises = [];
		var filteredResults = [];
		for(var i=0;i<results.length;i++) {
			//var difference = results[i].direction != "1" ? -Number(results[i].percentchange) : Number(results[i].percentchange);
			
			if(isOutsideThreshold(results[i], conf, logger)) {
				logger.info(promises[i].name + ': Percentage change is outside threshold.');
				filteredPromises.push(promises[i]);
				filteredResults.push(results[i]);
			} else {
				logger.info(promises[i].name + ': Percentage change is with-in threshold.');
			}
		}
		
		if (filteredResults.length > 0) {
			if (conf.lastMailingTime) {
				logger.info('LastMailingTime exists');
			
				var timeDiff = Math.abs(new Date() - conf.lastMailingTime);
				if((timeDiff/1000)/60 <= conf.mailIntervalInMinutes) {
					logger.info('LastMailingTime is within threshold. Skipping mail sending operation.');
					return;
				}
		
				logger.info('LastMailingTime is outside threshold.');
			}
			
			logger.info('Preparing mail content for items with NAV outside threshold.');
			var mailContent = formatMailContent(templateContent, null, filteredPromises, filteredResults, conf, logger);
			logger.info('Mail content prepared for items with NAV outside threshold');
		
			logger.info('Sending mail notification for items with NAV outside threshold');
			send({ html: mailContent }, function (err, res, full) {
				if (err) {
					logger.error('Error while sending mail. ' + err);
				} else{
					conf.lastMailingTime = new Date();
					logger.info('Mail sent successfully. ' + res);
				}
		
				logger.info('Mail notification response: ', full);
			});
		} else {
			logger.info('Indivual stocks are with-in threshold. Skipping mail sending operation.');
		}
	});
}

var requestCommodityFeed = function(send, templateContent, conf, logger) {
	https.get(conf.feedUrl, (res) => {
		res.on('data', (d) => {
			try {
				logger.info('Feed response received.');
				var result = JSON.parse(d);
				var indices = result.indices;
				if (indices) {
					var details = {
						commodity:  indices.stkexchg,
						exchange: indices.exchange,
						currentPrice: indices.lastprice,
						change: (indices.direction == "1" ? '+' : '-') + indices.change,
						direction: indices.direction,
						percentchange: (indices.direction == "1" ? '+' : '-') + indices.percentchange,
						openingPrice: indices.open,
						lastAvailablePrice: indices.prevclose,
						yearlylow: indices.yearlylow,
						yearlyhigh: indices.yearlyhigh
					};
					
					var data = "{commodity} : {currentPrice} ({lastAvailablePrice} {percentchange}'%') / Opening Price: {openingPrice} / 52 Weeks Low-High: {yearlylow}-{yearlyhigh}";
					logger.info('Data: ' + data.format(details));
					
					//var difference = indices.direction != "1" ? -Number(indices.percentchange) : Number(indices.percentchange);
					if(!isOutsideThreshold(details, conf, logger)) {
						logger.info('Percentage change is with-in threshold. Skipping mail sending operation.');
						
						logger.info('Checking for indivual stocks');
						individualStockWatch(send, templateContent, conf, logger);
						return;
					}
				
					logger.info('Percentage change is outside threshold.');
					var promises = [];
					for(var i=0;i<conf.stocks.length;i++) {
						var promise = getStockPrice(conf.stocks[i], conf, logger);
						promises.push({ name: conf.stocks[i].name, promise: promise });
					}
					
					var stockPromises = promises.map(function(x) {
						return x.promise;
					});
					
					Promise.all(stockPromises).then(function(results){
						logger.info('Preparing mail content');
						var mailContent = formatMailContent(templateContent, details, promises, results, conf, logger);
						logger.info('Mail content prepared');
				
						if (conf.lastMailingTime) {
							logger.info('LastMailingTime exists');
						
							var timeDiff = Math.abs(new Date() - conf.lastMailingTime);
							if((timeDiff/1000)/60 <= conf.mailIntervalInMinutes) {
								logger.info('LastMailingTime is within threshold. Skipping mail sending operation.');
								return;
							}
					
							logger.info('LastMailingTime is outside threshold.');
						}
			
						logger.info('Sending mail notification');
						send({ html: mailContent }, function (err, res, full) {
							if (err) {
								logger.error('Error while sending mail. ' + err);
							} else{
								conf.lastMailingTime = new Date();
								logger.info('Mail sent successfully. ' + res);
							}
					
							logger.info('Mail notification response: ', full);
						});
					});
				}
			} catch(e) {
				logger.error('Error while processing feed: ' + e);
			}
		});
	}).on('error', (e) => {
		logger.error('Error while retrieving feed: ' + e);
	});
};

try {
    dotenv.config();
    var runMode = process.env.MODE;
    var configFilePath = "{filePath}{runMode}.json".format({ filePath: filePath, runMode: runMode ? '.' + runMode : '' });
    var contents = fs.readFileSync(configFilePath, 'utf8');
	var conf = JSON.parse(contents);
    var logger = initLogs(conf);
    logger.info('Initializing ' + (runMode ? runMode : 'dev') + ' mode.');
	logger.info('Logging initialization successful!');
	
	try {
		logger.info('Initializing application!');
		appInit(conf, monitorFeed, logger);
	} catch(e){
		logger.error('Error while initializing application: ' + e.stack);
	}
} catch(e) {
    console.log('Error:', e.stack);
}