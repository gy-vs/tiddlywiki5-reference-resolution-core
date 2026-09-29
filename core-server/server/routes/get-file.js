/*\
title: $:/core/modules/server/routes/get-file.js
type: application/javascript
module-type: route

GET /files/:filepath

Serves files from the wiki "files" folder. Supports HTTP range requests
(RFC 7233) so that browser media elements can seek and download managers can
resume interrupted transfers. The file metadata is read with fs.stat() and
the file contents are streamed with a byte-sliced fs.ReadStream; the file is
never read into memory in one go.

\*/
"use strict";

exports.methods = ["GET"];

exports.path = /^\/files\/(.+)$/;

exports.info = {
	priority: 100
};

exports.handler = function(request,response,state) {
	var path = require("path"),
		fs = require("fs"),
		suppliedFilename = $tw.utils.decodeURIComponentSafe(state.params[0]),
		baseFilename = path.resolve(state.boot.wikiPath,"files"),
		filename = path.resolve(baseFilename,suppliedFilename),
		extension = path.extname(filename);
	// Check that the filename is inside the wiki files folder
	if(path.relative(baseFilename,filename).indexOf("..") === 0) {
		state.sendResponse(404,{"Content-Type": "text/plain"},"File '" + suppliedFilename + "' not found");
		return;
	}
	// Stat the file first: the size and modification time are all that is
	// needed to validate preconditions and to compute byte ranges
	fs.stat(filename,function(err,stats) {
		if(err) {
			console.log("Error accessing file " + filename + ": " + err.toString());
			sendNotFound(state,suppliedFilename);
			return;
		}
		if(!stats.isFile()) {
			// Directories and other non-regular files have no representation here
			sendNotFound(state,suppliedFilename);
			return;
		}
		var fileSize = stats.size,
			lastModified = stats.mtime.toUTCString(),
			// A strong validator built from the exact byte size and modification
			// time, matching what most static file servers use. Both are known
			// from fs.stat() without reading the file.
			etag = '"' + fileSize + "-" + Math.floor(stats.mtime.getTime()/1000) + '"',
			type = ($tw.config.fileExtensionInfo[extension] ? $tw.config.fileExtensionInfo[extension].type : "application/octet-stream"),
			headers = {
				"Content-Type": type,
				// Advertise range support on every response, including 200 and 416,
				// so that <video>/<audio> can seek and download tools can resume
				"Accept-Ranges": "bytes",
				"Etag": etag,
				"Last-Modified": lastModified
			},
			range = parseByteRange(request.headers.range,fileSize,etag,lastModified,request.headers["if-range"]);
		if(range === null) {
			// A syntactically valid byte range that cannot be satisfied
			headers["Content-Range"] = "bytes */" + fileSize;
			state.sendResponse(416,headers,"Requested range not satisfiable");
			return;
		}
		var statusCode,start,end;
		if(range) {
			statusCode = 206;
			start = range.start;
			end = range.end;
			headers["Content-Range"] = "bytes " + start + "-" + end + "/" + fileSize;
		} else {
			// No valid Range header (or a failed If-Range precondition): full 200
			statusCode = 200;
			start = 0;
			end = fileSize - 1;
		}
		headers["Content-Length"] = (end - start + 1).toString();
		if(fileSize === 0) {
			// An empty representation has no byte window to open: answer through
			// the ordinary buffered path with an empty body. Range requests for
			// an empty file already produced 416 above.
			state.sendResponse(statusCode,headers,Buffer.alloc(0));
			return;
		}
		// Open exactly the requested byte window, and only delegate to
		// state.sendResponse once the descriptor is open so that an open error
		// can still be reported as 404 through the ordinary response path
		var stream,
			delivered = false;
		try {
			stream = fs.createReadStream(filename,{start: start,end: end});
		} catch(openErr) {
			console.log("Error accessing file " + filename + ": " + openErr.toString());
			state.sendResponse(500,{"Content-Type": "text/plain"},"Internal server error");
			return;
		}
		var cancelBeforeOpen = function() {
			// The client went away before we started answering: don't leak the fd
			if(!delivered) {
				stream.destroy();
			}
		};
		response.once("close",cancelBeforeOpen);
		stream.once("ready",function() {
			delivered = true;
			response.removeListener("close",cancelBeforeOpen);
			// cancelBeforeOpen only fires while the response is still open, so if
			// it did not run the socket is usable; writableEnded covers the
			// defensive case of another path ending the response first.
			if(!response.writableEnded) {
				state.sendResponse(statusCode,headers,stream);
			} else {
				stream.destroy();
			}
		});
		stream.once("error",function(openErr) {
			if(delivered) {
				// sendResponse owns stream errors from the moment it receives it
				return;
			}
			response.removeListener("close",cancelBeforeOpen);
			console.log("Error accessing file " + filename + ": " + openErr.toString());
			if(!response.headersSent && !response.writableEnded) {
				sendNotFound(state,suppliedFilename);
			}
		});
	});
};

function sendNotFound(state,suppliedFilename) {
	state.sendResponse(404,{"Content-Type": "text/plain"},"File '" + suppliedFilename + "' not found");
}

/*
Parse a single byte range from an HTTP Range header, following RFC 7233
section 2.1. Return values:
* undefined – there is no range to honour: no header, an unsupported unit
  (anything other than "bytes"), a malformed range-spec, multiple ranges
  (multipart responses are not offered), or a failed If-Range precondition.
  The caller responds with the complete representation (200).
* null – the range is syntactically valid but cannot be satisfied for a
  representation of fileSize bytes. The caller responds 416.
* {start:,end:} – the inclusive byte window to serve. The caller responds 206.
*/
function parseByteRange(rangeHeader,fileSize,etag,lastModified,ifRangeHeader) {
	if(typeof rangeHeader !== "string" || rangeHeader === "") {
		return undefined;
	}
	// All whitespace in a Range header is insignificant (RFC 7233 permits it)
	var match = /^bytes=(.*)$/.exec(rangeHeader.replace(/[ \t]/g,""));
	if(!match) {
		// Other range units (e.g. "items=") are not understood
		return undefined;
	}
	var spec = match[1];
	if(spec === "" || spec.indexOf(",") !== -1) {
		// Ignore empty and multipart range requests rather than failing them
		return undefined;
	}
	var specMatch = /^(\d*)-(\d*)$/.exec(spec);
	if(!specMatch || (specMatch[1] === "" && specMatch[2] === "")) {
		// Malformed range-spec: the header is ignored per RFC 7233 section 3.1
		return undefined;
	}
	if(ifRangeHeader && !ifRangeMatches(ifRangeHeader,etag,lastModified)) {
		// The client only wants the range if the representation is still current
		return undefined;
	}
	var start,end;
	if(specMatch[1] === "") {
		// Suffix range: the last N bytes ("bytes=-N")
		var suffixLength = parseInt(specMatch[2],10);
		start = Math.max(0,fileSize - suffixLength);
		end = fileSize - 1;
	} else {
		start = parseInt(specMatch[1],10);
		end = specMatch[2] === "" ? fileSize - 1 : parseInt(specMatch[2],10);
	}
	if(fileSize === 0 || start >= fileSize || end < start) {
		return null;
	}
	// Clamp an over-long explicit range to the end of the representation
	return {start: start,end: Math.min(end,fileSize - 1)};
}

/*
Evaluate an If-Range precondition (RFC 7233 section 3.2). It carries either
the entity tag or the HTTP-date of the single partial response the client
already holds. Returns true only if the current representation matches, in
which case a 206 may be sent.
*/
function ifRangeMatches(ifRangeHeader,etag,lastModified) {
	var value = ifRangeHeader.replace(/^[ \t]+|[ \t]+$/g,"");
	if(value.slice(0,2) === "W/") {
		// A weak validator can never validate a range (RFC 7233 section 3.2)
		return false;
	}
	if(value.charAt(0) === '"') {
		return value === etag;
	}
	var requestedDate = Date.parse(value),
		currentDate = Date.parse(lastModified);
	if(isNaN(requestedDate) || isNaN(currentDate)) {
		// An unparseable precondition must not match: fall back to a full 200
		return false;
	}
	return requestedDate >= currentDate;
}
