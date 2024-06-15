# cf-reverse-proxy-ex
Cloudflare super reverse proxy, setting up a free proxy by using Cloudflare worker. Cloudflare超级代理，OpenAI/ChatGPT代理，Github加速，在线代理。

# 在线体验
https://y.demo.wvusd.homes/

# 用法
* 在cloudflare网站中新建worker，把worker.js文件中的内容复制进去即可使用。
* 在任意网址前面加上https://你的域名/<br>例如https://你的域名/https://github.com
* 本项目基于[gaboolic的cloudflare-reverse-proxy](https://github.com/gaboolic/cloudflare-reverse-proxy/)

# 详细步骤
* 登录https://www.cloudflare.com/
* 创建应用程序![创建应用程序](img/1createapp.png)
* 创建worker（pages麻烦一点，需要写一个package.json文件，但pages的好处是分配的域名直接可以用）![创建worker](img/2createworker.png)
* 点"部署"按钮![创建worker](img/3deploy.png)
* 编辑代码![编辑代码](img/4update.png)
* 把worker.js文件中的内容复制进去，点"保存并部署"![保存并部署](img/5save.png)
* (可选) 添加自定义域
<br>
* 免费域名申请：https://secure.nom.za/  https://nic.eu.org/   https://nic.ua
* 不需要申请，link域名0元免费1年：dynadot.com
* 域名购买：https://porkbun.com/  https://domain.com/<br >购买时可以Ctrl+F，搜素$0.

# 基于原项目的改进
* 去掉`/proxy/`，方便使用。我看到有issue说了，但是作者说想添加引导界面，这个问题我也解决了。
* 手动处理转跳事件（3XX），防止一些相对资源加载不出来。
* 判断欲代理的网址是否以`http`开头，如果不是就自动加上。
* 把header里所有有关代理网址的信息全部换成要代理的网站的信息，防止某些网站阻止代理。
* 相对路径全部转换绝对路径，方便加载资源（如JS，CSS等）。
* Cookie作用域修改成仅当代理那个网站时，防止Cookie太大服务器发来400 bad request，同时也可以防止一个敏感的Cookie被探测到导致整个网站无法使用，详细：https://github.com/gaboolic/cloudflare-reverse-proxy/issues/7 。
* 把`XMLHttpRequest`和`fetch`注入返回的HTML，这样也可以提交表单数据。
* 把一个文档监视器注入到返回的HTML，这样有新的链接也可以相对转绝对。
* 修改`Content-Security-Policy`和`X-Frame-Options`的Header，实现可代理Duckduckgo，同时也解决了一些网站打不开的问题。
* 在返回的时候，如果是HTML，那么添加`"Content-Type": "text/html; charset=utf-8"`，防止一些较为古老的中文网站打开出现`锟斤拷`，`烫烫烫`的问题。
* 优化了一些代码。

# 截图
![Duckduckgo](img/duckduckgo.jpg)
![BaiDu](img/baidu.jpg)
![Github](img/github.jpg)

# LICENSE

MIT License + 一些条件<br>
其实我犹豫了很久要不要开源，因为之前的开源项目有被人拿去坑人，卖钱，但是又不想让人们重复造轮子，所以决定加入两个条件：
* 凡是使用本项目建立的代理站点，务必备注此开源链接。
* 禁止使用本项目盈利，包括基于本项目的项目。
