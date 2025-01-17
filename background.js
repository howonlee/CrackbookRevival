var HITNUM_FONT = '12px Arial Bold';
var HITNUM_COLOR = "rgb(255,255,255)";
var HITNUM_POS_X = 3;
var HITNUM_POS_Y = 12;
var NOTIFICATION_TEXT = 'Time to get back to work!';

// TODO: the following should be configurable

var NOTIFICATION_THRESHOLD = 5;
var NOTIFICATION_HIT_INTERVAL = 5;

var TRACING = false;

function drawIcon(img_name) {
  img_path = "images/" + img_name;
  chrome.browserAction.setIcon({ path: img_path });
} // drawIcon

function drawTextOnBg(canvas, image, value) {
  var ctx = canvas.getContext('2d');

  ctx.drawImage(image, 0, 0);

  ctx.font = HITNUM_FONT;
  ctx.fillStyle = HITNUM_COLOR;
  ctx.fillText("" + value, HITNUM_POS_X, HITNUM_POS_Y);

  var imageData = ctx.getImageData(0, 0, 19, 19);
  chrome.browserAction.setIcon({ imageData: imageData });
} // drawTextOnBg

var iconState = null;

function updateIcon(active, inJunk) {
  if (active === null) // null or undefined
    active = extensionActive();
  if (inJunk === null) { // null or undefined
    chrome.tabs.getSelected(null, function (selectedTab) {
      var junkDomain = lookupJunkDomain(selectedTab.url);
      updateIcon(active, !!junkDomain);
    });
    return;
  }

  var newIcon = null;

  newIcon = inJunk ? 'hamburger' : 'carrot';
  if (!active)
    newIcon += '-inactive';
  newIcon += '-19px.png';

  if (iconState != newIcon) {
    iconState = newIcon;
    drawIcon(newIcon);
  }
}

function extensionActive() {
  var now = new Date();
  // Check weekday.
  if (getLocal('weekdays').indexOf("" + now.getDay()) == -1)
    return false;
  // Check time.
  var nowMins = parseTime(now.getHours() + ":" + now.getMinutes());
  var startTime = getLocal('startTime');
  var endTime = getLocal('endTime');
  if (startTime <= endTime) {
    return (startTime <= nowMins) && (nowMins <= endTime);
  } else {
    // Handle the case when, e.g. the end time is in the night (14:00-3:00).
    return (startTime <= nowMins) || (nowMins <= endTime);
  }
}

function shouldDimPage(tab) {
  var hitThresh = getTodaysHits() >= getLocal('dimmerThreshold');
  var hrefVal = tab.url;
  // stupid hash
  var winHash = Math.abs(hrefVal.split("").reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0)) % 100;
  var percent = winHash < getLocal('dimmerPercent');
  var res = hitThresh && percent;
  console.log(res);
  return res;
}

function toQueryString(obj) {
  // Convert an object to a query string.
  var components = [];
  for (var k in obj) {
    var v = obj[k];
    components.push(k + '=' + encodeURIComponent(v));
  }
  return components.join('&');
}

function registerHit(domain, blocked, active) {
  storeHit(domain, blocked, active);
}

// Returns true if the URL looks normal.
// Used to avoid trying to dim special-purpose tabs.
function isNormalUrl(s) {
  return s && ((s.indexOf('http://') === 0) || (s.indexOf('https://') === 0));
}

/*
 * Dimmer state transitions for junk pages
 *
 * handleNewPage:
 *  - tab active --> enable dimmer
 *  - tab inactive --> enable dimmer, suspend timer
 *
 * tabSelectionChangedHandler:
 *  - suspend timer on previous tab
 *  - restart timer on new tab
 *
 * windowFocusChangedHandler:
 *  - suspend timer on previous tab
 *  - restart timer on active tab
 *
 */

var lastDimmedTabId = null;

function handleNewPage(newTab, selectedTab, sendResponse) {
  // Every code path in this function should call sendResponse.
  // Collect data.
  var junkDomain = lookupJunkDomain(newTab.url);
  var active = extensionActive();
  var shouldDim = shouldDimPage(selectedTab);
  if (!junkDomain && getLocal('checkActiveTab')) {
    junkDomain = lookupJunkDomain(selectedTab.url);
    // TODO: This works for "open in background tab", but not for "open in
    // foreground tab" or "open in new window". Cover these cases by checking
    // the last seen tab, not just the active tab, and whether the switch was
    // recent.
    // TODO: This is easy to circumvent by immediately reloading a page. One
    // solution is to add a temporary blacklist of pages / domains.
  }

  updateIcon(null, !!junkDomain);

  var responseSent = false;

  if (junkDomain) {
    registerHit(junkDomain, shouldDim, active);

    if (active) {
      incrementJunkCounter(junkDomain);

      if (shouldDim) {
        var tabIsActive = (newTab.id == selectedTab.id);
       
        sendResponse({
          dimmerAction: tabIsActive ? "create" : "create_suspended",
	    options: {
	      blurBackground: getLocal('blurBackground'),
	      delay: getLocal('dimmerDelay'),
	    }
        });

        responseSent = true;

        if (tabIsActive) {
          lastDimmedTabId = newTab.id;
        }

        increaseDimmerDelay();
      }
    }
  }

  if (!responseSent) {
    sendResponse({});  // do nothing
  }
}

function increaseDimmerDelay() {
  var newDelay = getLocal('dimmerDelay') + getLocal('dimmerDelayIncrement');
  setLocal('dimmerDelay', newDelay);
}

function tabSelectionChangedHandler(tabId, selectInfo) {
  if (lastDimmedTabId) {
    invokeDimmer(lastDimmedTabId, "suspend");
    lastDimmedTabId = null;
  }

  chrome.tabs.get(tabId, function (tab) {
    if (isNormalUrl(tab.url)) {
      // If the page was opened from a junk page, the following check will not
      // indicate that this page is junk. Only the icon is affected though.
      var junkDomain = lookupJunkDomain(tab.url);
      updateIcon(null, !!junkDomain);
      invokeDimmer(tabId, "resume");
      lastDimmedTabId = tabId;
    }
  });
}

function windowFocusChangedHandler(windowId) {
  if (lastDimmedTabId) {
    // TODO: What if that tab does not exist any more?
    invokeDimmer(lastDimmedTabId, "suspend");
    lastDimmedTabId = null;
  }

  if (windowId != chrome.windows.WINDOW_ID_NONE) {
    chrome.tabs.getSelected(windowId, function (tab) {
      if (isNormalUrl(tab.url)) {
        var junkDomain = lookupJunkDomain(tab.url);
        updateIcon(null, !!junkDomain);
        if (junkDomain && shouldDimPage(tab)) {
          invokeDimmer(tab.id, "resume");
          lastDimmedTabId = tab.id;
        }
      }
    });
  }
}

// A wrapper function that also figures out the selected tab.
function newPageHandler(request, sender, sendResponse) {
  chrome.tabs.getSelected(null, function (selectedTab) {
    handleNewPage(sender.tab, selectedTab, sendResponse);
  });
}

function showNotification() {
  var notification_obj = webkitNotifications.createNotification(
    'images/hamburger-128px.png',
    NOTIFICATION_TEXT,
    "");
  notification_obj.show();
  window.setTimeout(function () { notification_obj.cancel(); }, 3000);
}

function incrementJunkCounter(domain) {
  var today = todayAsString();
  var day = getLocal('day');
  var hits = getLocal('dayHits');
  if (day == today) {
    hits += 1;
  } else {
    setLocal('day', today);
    hits = 1;
  }
  setLocal('dayHits', hits);

  // Also, if the day changed and reset_daily_flag is set, reset.
  if (day != today && getLocal('reset_daily_flag')) {
    setLocal('dimmerDelay', getLocal('base_delay'));
  }

  chrome.browserAction.setBadgeText({ text: "" + hits });
  setTimeout(function () { chrome.browserAction.setBadgeText({ text: '' }); },
    3000);

  // Show notification if needed.
  if (hits > NOTIFICATION_THRESHOLD && (hits % NOTIFICATION_HIT_INTERVAL === 0))
    // If hits >= dimmerThreshold, the notification is not needed any
    // more as the dimmer kicks in.
    if (hits < getLocal('dimmerThreshold'))
      showNotification();
}

function invokeDimmer(tabId, dimmerAction) {
  // Dim the page and start (or restart) the timer.
  //
  // Actions:
  // - "create": a dimmer is created on the page if it is not already there and a timer is started
  // - "create_suspended": a dimmer is created on the page if it is not already there, no timer is started
  // - "suspend": the countdown is suspended if there is a dimmer on the page
  // - "resume": the countdown is resumed if there is a dimmer on the page
  if (TRACING) {
    console.log("Invoking action: " + tabId + " -> " + dimmerAction);
  }
  var primer_code = "if (window.invoke_dimmer) { invoke_dimmer('" + dimmerAction + "'); }";
  chrome.tabs.executeScript(tabId, { code: primer_code });
}

function initIcon() {
  updateIcon(null, false);
}

function initExtension() {
  chrome.extension.onRequest.addListener(newPageHandler);
  chrome.tabs.onSelectionChanged.addListener(tabSelectionChangedHandler);
  chrome.windows.onFocusChanged.addListener(windowFocusChangedHandler);
  initIcon();

  if (getLocal('first_run') && getLocal('junkDomains').length === 0)
    chrome.tabs.create({ url: "options.html" });
}

initExtension();

