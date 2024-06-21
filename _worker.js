addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  thisProxyServerUrlHttps = `${url.protocol}//${url.hostname}/`;
  thisProxyServerUrl_hostOnly = url.host;
  //console.log(thisProxyServerUrlHttps);
  //console.log(thisProxyServerUrl_hostOnly);

  event.respondWith(handleRequest(event.request))
})

const str = "/";
const proxyCookie = "__PROXY_VISITEDSITE__";
var thisProxyServerUrlHttps;
var thisProxyServerUrl_hostOnly;
// const CSSReplace = ["https://", "http://"];
const httpRequestInjection = `

//information
var now = new URL(window.location.href);
var path = now.pathname.substring(1);
console.log("***************************----" + path);
if(!path.startsWith("http")) path = "https://" + path;
var base = now.host;
var protocol = now.protocol;
var nowlink = protocol + "//" + base + "/";
var original_host = path.substring(path.indexOf("://") + "://".length);
original_host = original_host.split('/')[0];
var mainOnly = path.substring(0, path.indexOf("://")) + "://" + original_host + "/";




inject();





//add change listener - new link
window.addEventListener('load', () => {
  loopAndConvertToAbs();
  obsPage();
});
console.log("WINDOW ONLOAD EVENT ADDED");



function loopAndConvertToAbs(){
  for(var ele of document.querySelectorAll('*')){
    covToAbs(ele);
  }
  console.log("LOOPED EVERY ELEMENT");
}
function inject(){
  //inject network request
  var originalOpen = XMLHttpRequest.prototype.open;
  var originalFetch = window.fetch;
  XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
    if(url.indexOf(nowlink) != 0){
      var u = new URL(url, path).href;
      u = u.replace(window.location.href, path);
      u = u.replace(encodeURI(window.location.href), path);
      u = u.replace(encodeURIComponent(window.location.href), path);

      u = u.replace(nowlink, mainOnly);
      u = u.replace(nowlink, encodeURI(mainOnly));
      u = u.replace(nowlink, encodeURIComponent(mainOnly));
      // mainOnly最后带/，要再替换一遍不带的
      //反正是客户端执行，没人在乎那几毫秒，也没人在乎那0.01%的CPU占用。
      u = u.replace(nowlink, mainOnly.substring(0,mainOnly.length - 1));
      u = u.replace(nowlink, encodeURI(mainOnly.substring(0,mainOnly.length - 1)));
      u = u.replace(nowlink, encodeURIComponent(mainOnly.substring(0,mainOnly.length - 1)));

      u = u.replace(base, original_host);
      url = nowlink + u;
    }
    console.log("R:" + url);
    return originalOpen.apply(this, arguments);
  };

  window.fetch = function(input, init) {
    var url;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request) {
      url = input.url;
    } else {
      url = input;
    }
  
    if (url.indexOf(nowlink) != 0) {
      var u = new URL(url, path).href;
      u = u.replace(window.location.href, path);
      u = u.replace(encodeURI(window.location.href), path);
      u = u.replace(encodeURIComponent(window.location.href), path);

      u = u.replace(nowlink, mainOnly);
      u = u.replace(nowlink, encodeURI(mainOnly));
      u = u.replace(nowlink, encodeURIComponent(mainOnly));
      // mainOnly最后带/，要再替换一遍不带的
      //反正是客户端执行，没人在乎那几毫秒，也没人在乎那0.01%的CPU占用。
      u = u.replace(nowlink, mainOnly.substring(0,mainOnly.length - 1));
      u = u.replace(nowlink, encodeURI(mainOnly.substring(0,mainOnly.length - 1)));
      u = u.replace(nowlink, encodeURIComponent(mainOnly.substring(0,mainOnly.length - 1)));

      u = u.replace(base, original_host);
      url = nowlink + u;
    }
    
    console.log("R:" + url);
    if (typeof input === 'string') {
      return originalFetch(url, init);
    } else {
      const newRequest = new Request(url, input);
      return originalFetch(newRequest, init);
    }
  };
  
  console.log("NETWORK REQUEST METHOD INJECTED");

}


function obsPage(){
  var yProxyObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            covToAbs(mutation.target);
            console.log(mutation.target);
            
        });
    });
  var config = { attributes: true, childList: true, subtree: true };
  yProxyObserver.observe(document.body, config);

  console.log("OBSERVING THE WEBPAGE...");
}

function covToAbs(element){
  var relativePath = "";
  var setAttr = "";
  if (element instanceof HTMLElement && element.hasAttribute("href")) {
    relativePath = element.getAttribute("href");
    setAttr = "href";
  }
  if (element instanceof HTMLElement && element.hasAttribute("src")) {
    relativePath = element.getAttribute("src");
    setAttr = "src";
  }

  // Check and update the attribute if necessary
  if (setAttr !== "" && relativePath.indexOf(nowlink) != 0) { 
    if (!relativePath.includes("*")) {
      if (!relativePath.startsWith("data:") && !relativePath.startsWith("javascript:")) {
        try {
          var absolutePath = nowlink + new URL(relativePath, path).href;
          console.log(absolutePath);
          element.setAttribute(setAttr, absolutePath);
        } catch (e) {
          console.log(path + "   " + relativePath);
        }
      }
    }
  }
}

`;
const mainPage = `
<html>
<head>
  <style>
    body{
      background:rgb(150,10,10);
      color:rgb(240,240,0);
    }
    a{
      color:rgb(250,250,180);
    }
    del{
      color:rgb(190,190,190);
    }
    .center{
      text-align:center;
    }
    .important{
      font-weight:bold;
      font-size:27;
    }
  </style>
</head>
<body>
  <h3 class="center">
    I made this project because some extreme annoying network filter software in my school, which is notorious "Goguardian", and now it is open source at <a>https://github.com/1234567Yang/cf-proxy-ex/</a>.
  </h3>
  <br><br><br>
  <ul style="font-size:25;">
  <li class="important">How to use this proxy:<br>
    Type the website you want to go to after the website's url, for example: <br>
    https://the current url/github.com<br>OR<br>https://the current url/https://github.com</li>
    <br>
    <li>If your browser show 400 bad request, please clear your browser cookie<br></li>
    <li>Why I make this:<br> Because school blcok every website that I can find math / CS and other subjects' study material and question solutions. In the eyes of the school, China (and some other countries) seems to be outside the scope of this "world". They block access to server IP addresses in China and block access to Chinese search engines and video websites. Of course, some commonly used social software has also been blocked, which once made it impossible for me to send messages to my parents on campus. I don't think that's how it should be, so I'm going to fight it as hard as I can. I believe this will not only benefit myself, but a lot more people can get benefits.</li>
   <li>If this website is blocked by your school: <br>Contact me at <a href="mailto:help@wvusd.homes">help@wvusd.homes</a>, and I will setup a new webpage.</li>
    <li>Limitation:<br>Although I tried my best to make every website proxiable, there still might be pages or resources that can not be load, and the most important part is that <span class="important">YOU SHOULD NEVER LOGIN ANY ACCOUNT VIA ONLINE PROXY</span>.</li>
  </ul>

  <h1 style="font-size:30">

  </h1>
  <br><br><br>
  <h3>
    
    <br>
    <span>Proxies that can bypass the school network blockade:</span>
    <br><br>
    <span>Traditional VPNs such as <a href="https://hide.me/">hide me</a>.</span>
    <br><br>
    <a href="https://www.torproject.org/">Tor Browser</a><span>, short for The Onion Router, is free and open-source software for enabling anonymous communication. It directs Internet traffic via a free, worldwide volunteer overlay network that consists of more than seven thousand relays. Using Tor makes it more difficult to trace a user's Internet activity.</span>
    <br><br>
    <a href="https://v2rayn.org/">v2RayN</a><span> is a GUI client for Windows, support Xray core and v2fly core and others. You must subscribe to an <a href = "https://aijichang.org/6190/">airport</a> to use it. For example, you can subscribe <a href="https://feiniaoyun.xyz/">fly bird cloud</a>.</span>
    <br><br>
    <span>Bypass <del>Goguardian</del> by proxy: You can buy a domain($1) and setup by yourself: </span><a href="https://github.com/gaboolic/cloudflare-reverse-proxy">how to setup a proxy</a><span>. Unless <del>Goguardian</del> use white list mode, this can always work.</span>
    <br>
    <span>Too expensive? Never mind! There are a lot of free domains registration companies (for the first year of the domain) that do not need any credit card, search online!</span>
    <br><br>
    <span>Youtube video unblock: "Thanks" for Russia that they started to invade Ukraine and Google blocked the traffic from Russia, there are a LOT of mirror sites working. You can even <a href="https://github.com/iv-org/invidious">setup</a> one by yourself.</span>
  </h3>
  <a href="https://goguardian.com" style="visibility:hidden"></a>
  <a href="https://blocked.goguardian.com/" style="visibility:hidden"></a>
  <a href="https://www.google.com/gen_204" style="visibility:hidden"></a>
  <p style="font-size:280px !important;width:100%;location:relative;" class="center">
    ☭
  </p>
</body>
</html>
`;
const redirectError = `
<html><head></head><body><h2>Error while redirecting: the website you want to access to may contain wrong redirect information, and we can not parse the info</h2></body></html>
`;

//new URL(请求路径, base路径).href;

async function handleRequest(request) {
  const url = new URL(request.url);
  //var siteOnly = url.pathname.substring(url.pathname.indexOf(str) + str.length);

  var actualUrlStr = url.pathname.substring(url.pathname.indexOf(str) + str.length) + url.search + url.hash;
  if (actualUrlStr == "") { //先返回引导界面
    return getHTMLResponse(mainPage);
  }


  try {
    var test = actualUrlStr;
    if (!test.startsWith("http")) {
      test = "https://" + test;
    }
    var u = new URL(test);
    if (!u.host.includes(".")) {
      throw new Error();
    }
  }
  catch { //可能是搜素引擎，比如proxy.com/https://www.duckduckgo.com/ 转到 proxy.com/?q=key
    var siteCookie = request.headers.get('Cookie');
    var lastVisit;
    if (siteCookie != null && siteCookie != "") {
      lastVisit = getCook(proxyCookie, siteCookie);
      console.log(lastVisit);
      if (lastVisit != null && lastVisit != "") {
        //(!lastVisit.startsWith("http"))?"https://":"" + 
        //现在的actualUrlStr如果本来不带https:// 的话那么现在也不带，因为判断是否带protocol在后面
        return Response.redirect(thisProxyServerUrlHttps + lastVisit + "/" + actualUrlStr, 301);
      }
    }
    return getHTMLResponse("Something is wrong while trying to get your cookie: <br> siteCookie: " + siteCookie + "<br>" + "lastSite: " + lastVisit);
  }



  if (!actualUrlStr.startsWith("http") && !actualUrlStr.includes("://")) { //从www.xxx.com转到https://www.xxx.com
    //actualUrlStr = "https://" + actualUrlStr;
    return Response.redirect(thisProxyServerUrlHttps + "https://" + actualUrlStr, 301);
  }
  //if(!actualUrlStr.endsWith("/")) actualUrlStr += "/";
  const actualUrl = new URL(actualUrlStr);

  let clientHeaderWithChange = new Headers();
  //***代理发送数据的Header：修改部分header防止403 forbidden，要先修改，   因为添加Request之后header是只读的（***ChatGPT，未测试）
  for (var pair of request.headers.entries()) {
    //console.log(pair[0]+ ': '+ pair[1]);
    clientHeaderWithChange.set(pair[0], pair[1].replaceAll(thisProxyServerUrlHttps, actualUrlStr).replaceAll(thisProxyServerUrl_hostOnly, actualUrl.host));
  }

  let clientRequestBodyWithChange
  if (request.body) {
    clientRequestBodyWithChange = await request.text();
    clientRequestBodyWithChange = clientRequestBodyWithChange
      .replaceAll(thisProxyServerUrlHttps, actualUrlStr)
      .replaceAll(thisProxyServerUrl_hostOnly, actualUrl.host);
  }

  const modifiedRequest = new Request(actualUrl, {
    headers: clientHeaderWithChange,
    method: request.method,
    body: (request.body) ? clientRequestBodyWithChange : request.body,
    //redirect: 'follow'
    redirect: "manual"
    //因为有时候会
    //https://www.jyshare.com/front-end/61   重定向到
    //https://www.jyshare.com/front-end/61/
    //但是相对目录就变了
  });

  //console.log(actualUrl);

  const response = await fetch(modifiedRequest);
  if (response.status.toString().startsWith("3") && response.headers.get("Location") != null) {
    //console.log(base_url + response.headers.get("Location"))
    try {
      return Response.redirect(thisProxyServerUrlHttps + new URL(response.headers.get("Location"), actualUrlStr).href, 301);
    } catch {
      getHTMLResponse(redirectError + "<br>the redirect url:" + response.headers.get("Location") + ";the url you are now at:" + actualUrlStr);
    }
  }

  var modifiedResponse;
  var bd;

  const contentType = response.headers.get("Content-Type");
  if (contentType && contentType.startsWith("text/")) {
    bd = await response.text();

    //ChatGPT
    let regex = new RegExp(`(?<!src="|href=")(https?:\\/\\/[^\s'"]+)`, 'g');
    bd = bd.replace(regex, (match) => {
      if (match.includes("http")) {
        return thisProxyServerUrlHttps + match;
      } else {
        return thisProxyServerUrl_hostOnly + "/" + match;
      }
    });

    console.log(bd); // 输出替换后的文本

    //bd.includes("<html")  //不加>因为html标签上可能加属性         这个方法不好用因为一些JS中竟然也会出现这个字符串
    if (contentType && contentType.includes("text/html")) {
      //console.log("STR" + actualUrlStr)
      bd = covToAbs(bd, actualUrlStr);
      bd = "<script>" + httpRequestInjection + "</script>" + bd;
    }
    //else{
    //   //const type = response.headers.get('Content-Type');type == null || (type.indexOf("image/") == -1 && type.indexOf("application/") == -1)
    //   if(actualUrlStr.includes(".css")){ //js不用，因为我已经把网络消息给注入了
    //     for(var r of CSSReplace){
    //       bd = bd.replace(r, thisProxyServerUrlHttps + r);
    //     }
    //   }
    //   //问题:在设置css background image 的时候可以使用相对目录  
    // }
    //console.log(bd);

    modifiedResponse = new Response(bd, response);
  } else {
    var blob = await response.blob();
    modifiedResponse = new Response(blob, response);
  }




  let headers = modifiedResponse.headers;
  let cookieHeaders = [];

  // Collect all 'Set-Cookie' headers regardless of case
  for (let [key, value] of headers.entries()) {
    if (key.toLowerCase() == 'set-cookie') {
      cookieHeaders.push({ headerName: key, headerValue: value });
    }
  }


  if (cookieHeaders.length > 0) {
    cookieHeaders.forEach(cookieHeader => {
      let cookies = cookieHeader.headerValue.split(',').map(cookie => cookie.trim());

      for (let i = 0; i < cookies.length; i++) {
        let parts = cookies[i].split(';').map(part => part.trim());
        //console.log(parts);

        // Modify Path
        let pathIndex = parts.findIndex(part => part.toLowerCase().startsWith('path='));
        let originalPath;
        if (pathIndex !== -1) {
          originalPath = parts[pathIndex].substring("path=".length);
        }
        let absolutePath = "/" + new URL(originalPath, actualUrlStr).href;;

        if (pathIndex !== -1) {
          parts[pathIndex] = `Path=${absolutePath}`;
        } else {
          parts.push(`Path=${absolutePath}`);
        }

        // Modify Domain
        let domainIndex = parts.findIndex(part => part.toLowerCase().startsWith('domain='));

        if (domainIndex !== -1) {
          parts[domainIndex] = `domain=${thisProxyServerUrl_hostOnly}`;
        } else {
          parts.push(`domain=${thisProxyServerUrl_hostOnly}`);
        }

        cookies[i] = parts.join('; ');
      }

      // Re-join cookies and set the header
      headers.set(cookieHeader.headerName, cookies.join(', '));
    });
  }
  //bd != null && bd.includes("<html")
  if (contentType && contentType.includes("text/html") && response.status == 200) { //如果是HTML再加cookie，因为有些网址会通过不同的链接添加CSS等文件
    let cookieValue = proxyCookie + "=" + actualUrl.origin + "; Path=/; Domain=" + thisProxyServerUrl_hostOnly;
    //origin末尾不带/
    //例如：console.log(new URL("https://www.baidu.com/w/s?q=2#e"));
    //origin: "https://www.baidu.com"
    headers.append("Set-Cookie", cookieValue);
  }

  // 添加允许跨域访问的响应头
  modifiedResponse.headers.set('Access-Control-Allow-Origin', '*');
  //modifiedResponse.headers.set("Content-Security-Policy", "default-src *; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data:; media-src *; frame-src *; font-src *; connect-src *; base-uri *; form-action *;");
  if (modifiedResponse.headers.has("Content-Security-Policy")) {
    modifiedResponse.headers.delete("Content-Security-Policy");
  }
  modifiedResponse.headers.set("X-Frame-Options", "ALLOWALL");

  return modifiedResponse;
}
function escapeRegExp(string) {
  return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& 表示匹配的字符
}

//https://stackoverflow.com/questions/5142337/read-a-javascript-cookie-by-name
function getCook(cookiename, cookies) {
  // Get name followed by anything except a semicolon
  var cookiestring = RegExp(cookiename + "=[^;]+").exec(cookies);
  // Return everything after the equal sign, or an empty string if the cookie name not found
  return decodeURIComponent(!!cookiestring ? cookiestring.toString().replace(/^[^=]+./, "") : "");
}

const matchList = [[/href=("|')([^"']*)("|')/g, `href="`], [/src=("|')([^"']*)("|')/g, `src="`]];
function covToAbs(body, requestPathNow) {
  var original = [];
  var target = [];

  for (var match of matchList) {
    var setAttr = body.matchAll(match[0]);
    if (setAttr != null) {
      for (var replace of setAttr) {
        if (replace.length == 0) continue;
        var strReplace = replace[0];
        if (!strReplace.includes(thisProxyServerUrl_hostOnly)) {
          if (!isPosEmbed(body, replace.index)) {
            var relativePath = strReplace.substring(match[1].toString().length, strReplace.length - 1);
            if (!relativePath.startsWith("data:") && !relativePath.startsWith("javascript:")) {
              try {
                var absolutePath = thisProxyServerUrlHttps + new URL(relativePath, requestPathNow).href;
                //body = body.replace(strReplace, match[1].toString() + absolutePath + `"`);
                original.push(strReplace);
                target.push(match[1].toString() + absolutePath + `"`);
              } catch {
                // 无视
              }
            }
          }
        }
      }
    }
  }
  for (var i = 0; i < original.length; i++) {
    body = body.replace(original[i], target[i]);
  }
  return body;
}

// console.log(isPosEmbed("<script src='https://www.google.com/'>uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu</script>",2));
// VM195:1 false
// console.log(isPosEmbed("<script src='https://www.google.com/'>uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu</script>",10));
// VM207:1 false
// console.log(isPosEmbed("<script src='https://www.google.com/'>uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu</script>",50));
// VM222:1 true
function isPosEmbed(html, pos) {
  if (pos > html.length || pos < 0) return false;
  //取从前面`<`开始后面`>`结束，如果中间有任何`<`或者`>`的话，就是content
  //<xx></xx><script>XXXXX[T]XXXXXXX</script><tt>XXXXX</tt>
  //         |-------------X--------------|
  //                !               !
  //         conclusion: in content

  // Find the position of the previous '<'
  let start = html.lastIndexOf('<', pos);
  if (start === -1) start = 0;

  // Find the position of the next '>'
  let end = html.indexOf('>', pos);
  if (end === -1) end = html.length;

  // Extract the substring between start and end
  let content = html.slice(start + 1, end);
  // Check if there are any '<' or '>' within the substring (excluding the outer ones)
  if (content.includes(">") || content.includes("<")) {
    return true; // in content
  }
  return false;

}
function getHTMLResponse(html) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}
