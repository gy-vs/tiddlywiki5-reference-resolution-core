/*\
title: $:/core/modules/server/routes/get-file.js
type: application/javascript
module-type: route

GET /files/:filepath

\*/
"use strict";

exports.methods = ["GET"];

exports.path = /^\/files\/(.+)$/;

exports.info = {
	priority: 100
};

/*
Parse a single byte range from an HTTP Range header (RFC 7233 section 3.1).
Only `bytes=start-end` and `bytes=start-` / `bytes=-suffix` specifications
are honoured: syntactically invalid ranges and ranges in other units are
ignored by returning null, in which case the whole representation is sent
with a 200 response, as required by the spec.
Returns an object {start,end} with inclusive absolute byte offsets, or
"unsatisfiable" for a syntactically valid range that cannot be applied to
a file of the given size.
*/
function parseSingleByteRange(rangeHeader,fileSize) {
	if(!rangeHeader || rangeHeader.slice(0,6) !== "bytes=") {
		return null;
	}
	var spec = rangeHeader.slice(6).replace(/[ \t]/g,"");
	// Only a single range specification is supported; a multipart request is ignored
	if(spec.indexOf(",") !== -1) {
		return null;
	}
	var dashPosition = spec.indexOf("-");
	if(dashPosition === -1) {
		return null;
	}
	var startString = spec.slice(0,dashPosition),
		endString = spec.slice(dashPosition + 1),
		start,
		end;
	if(startString === "") {
		// Suffix range: the last N bytes of the representation
		if(endString === "" || !/^\d+$/.test(endString)) {
			return null;
		}
		var suffixLength = parseInt(endString,10);
		start = fileSize - suffixLength;
		if(start < 0) {
			// The representation is shorter than the requested suffix
			start = 0;
		}
		end = fileSize - 1;
	} else if(!/^\d+$/.test(startString)) {
		return null;
	} else if(endString === "") {
		// Open-ended range: bytes from `start` to the end of the file
		start = parseInt(startString,10);
		end = fileSize - 1;
	} else if(!/^\d+$/.test(endString)) {
		return null;
	} else {
		start = parseInt(startString,10);
		end = parseInt(endString,10);
		// A range whose first byte position is greater than its last
		// is syntactically valid but unsatisfiable
		if(start > end) {
			return "unsatisfiable";
		}
		// The end of the range is clipped to the last byte of the file
		if(end > fileSize - 1) {
			end = fileSize - 1;
		}
	}
	if(start >= fileSize) {
		return "unsatisfiable";
	}
	return {start: start,end: end};
}

exports.handler = function(request,response,state) {
	var path = require("path"),
		fs = require("fs"),
		suppliedFilename = $tw.utils.decodeURIComponentSafe(state.params[0]),
		baseFilename = path.resolve(state.boot.wikiPath,"files"),
		filename = path.resolve(baseFilename,suppliedFilename),
		extension = path.extname(filename);
	// Check that the filename is inside the wiki files folder
	if(path.relative(baseFilename,filename).indexOf("..") !== 0) {
		// Stat the file so that it can be streamed rather than being read whole into memory
		fs.stat(filename,function(err,stats) {
			if(err || !stats.isFile()) {
				if(err) {
					console.log("Error accessing file " + filename + ": " + err.toString());
				}
				// Errors before any data is streamed still take the common response path
				state.sendResponse(404,{"Content-Type": "text/plain"},"File '" + suppliedFilename + "' not found");
				return;
			}
			var type = ($tw.config.fileExtensionInfo[extension] ? $tw.config.fileExtensionInfo[extension].type : "application/octet-stream"),
				fileSize = stats.size,
				range = parseSingleByteRange(request.headers.range,fileSize),
				headers,
				streamStart,
				streamEnd;
			// Mirror the caching contract of Server.sendResponse without buffering the
			// file: when browser caching is enabled a stat-based validator is advertised
			// and an unconditional GET carrying a matching validator is answered 304.
			if(state.server.enableBrowserCache) {
				var etag = '"' + fileSize.toString(16) + "-" + stats.mtime.getTime().toString(16) + '"';
				headers = {
					"Etag": etag,
					"Cache-Control": "max-age=0, must-revalidate"
				};
				if(!range && request.headers["if-none-match"]) {
					var matchParts = request.headers["if-none-match"].split(",").map(function(validator) {
						return validator.replace(/^[ "]+|[ "]+$/g,"");
					});
					if(matchParts.indexOf(etag.slice(1,-1)) !== -1) {
						response.writeHead(304,headers);
						response.end();
						return;
					}
				}
			} else {
				headers = {
					"Cache-Control": "no-store"
				};
			}
			if(range === "unsatisfiable") {
				// RFC 7233 section 4.4: the 416 response indicates the unsatisfiable
				// extent. Sent directly (rather than via sendResponse) so the
				// Content-Range header is preserved and the body is never compressed.
				headers["Content-Type"] = "text/plain";
				headers["Content-Range"] = "bytes */" + fileSize;
				response.writeHead(416,headers);
				response.end("Requested range not satisfiable");
				return;
			}
			if(range) {
				// Partial content: browsers rely on this for <video>/<audio> seeking and
				// download tools use it to resume interrupted transfers
				streamStart = range.start;
				streamEnd = range.end;
				headers["Content-Type"] = type;
				headers["Accept-Ranges"] = "bytes";
				headers["Content-Range"] = "bytes " + streamStart + "-" + streamEnd + "/" + fileSize;
				headers["Content-Length"] = streamEnd - streamStart + 1;
				response.writeHead(206,headers);
			} else {
				// Full representation: advertising Accept-Ranges lets clients issue range requests.
				// The body is always streamed with identity encoding rather than sent through the
				// gzip path in sendResponse: advertised byte ranges must address the on-disk bytes
				// and compression would both require buffering the whole file and make seeking ambiguous.
				streamStart = 0;
				streamEnd = fileSize - 1;
				headers["Content-Type"] = type;
				headers["Accept-Ranges"] = "bytes";
				headers["Content-Length"] = fileSize;
				response.writeHead(200,headers);
			}
			// Stream just the requested byte window straight to the response
			if(fileSize === 0) {
				// An empty file has no bytes to stream
				response.end();
				return;
			}
			var stream = fs.createReadStream(filename,{start: streamStart,end: streamEnd});
			stream.on("error",function(streamErr) {
				console.log("Error streaming file " + filename + ": " + streamErr.toString());
				if(response.headersSent) {
					// The status line is already on the wire; abort the partial response
					response.destroy(streamErr);
				} else {
					response.writeHead(500,{"Content-Type": "text/plain"});
					response.end("Internal server error");
				}
			});
			// Stop reading from disk if the client disconnects or finishes early
			response.on("close",function() {
				stream.destroy();
			});
			stream.pipe(response);
		});
	} else {
		state.sendResponse(404,{"Content-Type": "text/plain"},"File '" + suppliedFilename + "' not found");
	}
};
