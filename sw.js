"use strict";

const OFFLINE_DATA_FILE = "offline.js";
const CACHE_NAME_PREFIX = "c2offline";
const BROADCASTCHANNEL_NAME = "offline";
const CONSOLE_PREFIX = "[SW] ";

const broadcastChannel = (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(BROADCASTCHANNEL_NAME));

function PostBroadcastMessage(o)
{
	if (!broadcastChannel)
		return;		// not supported
	
	setTimeout(() => broadcastChannel.postMessage(o), 3000);
};

function Broadcast(type)
{
	PostBroadcastMessage({
		"type": type
	});
};

function BroadcastDownloadingUpdate(version)
{
	PostBroadcastMessage({
		"type": "downloading-update",
		"version": version
	});
}

function BroadcastUpdateReady(version)
{
	PostBroadcastMessage({
		"type": "update-ready",
		"version": version
	});
}

function GetCacheBaseName()
{
	
	return CACHE_NAME_PREFIX + "-" + self.registration.scope;
};

function GetCacheVersionName(version)
{

	return GetCacheBaseName() + "-v" + version;
};

function GetAvailableCacheNames()
{
	return caches.keys()
	.then(cacheNames =>
	{
		const cacheBaseName = GetCacheBaseName();
		return cacheNames.filter(n => n.startsWith(cacheBaseName));
	});
};

function IsUpdatePending()
{
	return GetAvailableCacheNames()
	.then(availableCacheNames => availableCacheNames.length >= 2);
};

function GetMainPageUrl()
{
	return clients.matchAll({
		includeUncontrolled: true,
		type: "window"
	})
	.then(clients =>
	{
		for (let c of clients)
		{
			let url = c.url;
			if (url.startsWith(self.registration.scope))
				url = url.substring(self.registration.scope.length);
			
			if (url && url !== "/")		
			{
				if (url.startsWith("?"))
					url = "/" + url;
				
				return url;
			}
		}
		
		return "";		
	});
};


function fetchWithBypass(request, bypassCache)
{
	if (typeof request === "string")
		request = new Request(request);
	
	if (bypassCache)
	{

		const url = new URL(request.url);
		url.search += Math.floor(Math.random() * 1000000);

		return fetch(url, {
			headers: request.headers,
			mode: request.mode,
			credentials: request.credentials,
			redirect: request.redirect,
			cache: "no-store"
		});
	}
	else
	{

		return fetch(request);
	}
};


function CreateCacheFromFileList(cacheName, fileList, bypassCache)
{

	return Promise.all(fileList.map(url => fetchWithBypass(url, bypassCache)))
	.then(responses =>
	{

		let allOk = true;
		
		for (let response of responses)
		{
			if (!response.ok)
			{
				allOk = false;
				console.error(CONSOLE_PREFIX + "Error fetching '" + originalUrl + "' (" + response.status + " " + response.statusText + ")");
			}
		}
		
		if (!allOk)
			throw new Error("not all resources were fetched successfully");
		

		return caches.open(cacheName)
		.then(cache =>
		{
			return Promise.all(responses.map(
				(response, i) => cache.put(fileList[i], response)
			));
		})
		.catch(err =>
		{

			console.error(CONSOLE_PREFIX + "Error writing cache entries: ", err);
			caches.delete(cacheName);
			throw err;
		});
	});
};

function UpdateCheck(isFirst)
{

	return fetchWithBypass(OFFLINE_DATA_FILE, true)
	.then(r => r.json())
	.then(data =>
	{
		const version = data.version;
		let fileList = data.fileList;
		const currentCacheName = GetCacheVersionName(version);
		
		return caches.has(currentCacheName)
		.then(cacheExists =>
		{
			// Don't recache if there is already a cache that exists for this version. Assume it is complete.
			if (cacheExists)
			{
				// Log whether we are up-to-date or pending an update.
				return IsUpdatePending()
				.then(isUpdatePending =>
				{
					if (isUpdatePending)
					{
						console.log(CONSOLE_PREFIX + "Update pending");
						Broadcast("update-pending");
					}
					else
					{
						console.log(CONSOLE_PREFIX + "Up to date");
						Broadcast("up-to-date");
					}
				});
			}
			
			// Implicitly add the main page URL to the file list, e.g. "index.html", so we don't have to assume a specific name.
			return GetMainPageUrl()
			.then(mainPageUrl =>
			{
				
				fileList.unshift("./");
				
				if (mainPageUrl && fileList.indexOf(mainPageUrl) === -1)
					fileList.unshift(mainPageUrl);
				
				console.log(CONSOLE_PREFIX + "Caching " + fileList.length + " files for offline use");
				
				if (isFirst)
					Broadcast("downloading");
				else
					BroadcastDownloadingUpdate(version);
				
				return CreateCacheFromFileList(currentCacheName, fileList, !isFirst)
				.then(IsUpdatePending)
				.then(isUpdatePending =>
				{
					if (isUpdatePending)
					{
						console.log(CONSOLE_PREFIX + "All resources saved, update ready");
						BroadcastUpdateReady(version);
					}
					else
					{
						console.log(CONSOLE_PREFIX + "All resources saved, offline support ready");
						Broadcast("offline-ready");
					}
				});
			});
		});
	})
	.catch(err =>
	{
		// Update check fetches fail when we're offline, but in case there's any other kind of problem with it, log a warning.
		console.warn(CONSOLE_PREFIX + "Update check failed: ", err);
	});
};

self.addEventListener('install', event =>
{
	event.waitUntil(
		UpdateCheck(true)		// first update
		.catch(() => null)
	);
});

self.addEventListener('fetch', event =>
{
	const isNavigateRequest = (event.request.mode === "navigate");
	
	let responsePromise = GetAvailableCacheNames()
	.then(availableCacheNames =>
	{
		// No caches available: go to network
		if (!availableCacheNames.length)
			return fetch(event.request);
		
		// Resolve with the cache name to use.
		return Promise.resolve().then(() =>
		{

			if (availableCacheNames.length === 1 || !isNavigateRequest)
				return availableCacheNames[0];
			
			// We are making a navigate request with more than one cache available. Check if we can expire any old ones.
			return clients.matchAll().then(clients =>
			{

				if (clients.length > 1)
					return availableCacheNames[0];
				
				// Identify newest cache to use. Delete all the others.
				let latestCacheName = availableCacheNames[availableCacheNames.length - 1];
				console.log(CONSOLE_PREFIX + "Updating to new version");
				
				return Promise.all(availableCacheNames.slice(0, -1)
									.map(c => caches.delete(c)))
				.then(() => latestCacheName);
			});
		}).then(useCacheName =>
		{
			return caches.open(useCacheName)
			.then(c => c.match(event.request))
			.then(response => response || fetch(event.request));
		});
	});

	if (isNavigateRequest)
	{
		event.waitUntil(responsePromise
		.then(() => UpdateCheck(false)));		// not first check
	}

	event.respondWith(responsePromise);
});