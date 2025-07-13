> [!CAUTION]
> 根据[Cloudflare ToS](cloudflare.com/terms) 2.2.1 (j)，您不能在任何情况下对本项目进行在Cloudflare上的实际的架设和使用，您只能并且仅限于学习本项目中的在线代理的实现方式，或者使用Cloudflare开源的worker-runtime在自己的服务器上部署，否则后果自负。
>
> 本项目仅用于学习在线代理的实现方式，用cloudflare-worker代码只是因为方便编写，绝无任何引导目的。

> [!CAUTION]
> 经过实际测试，Cloudflare代理会将你的真实IP通过`X-Forwarded-For`、`X-Real-Ip`、`Cf-Connecting-Ip`传递给目标网站，可能导致个人信息泄漏。同时，它还会通过`Cf-Worker`将你的Worker域名发送给目标网站。

![实际测试](img/depoly/cf/cf_realip.png)

# 步骤

* 登录https://dash.cloudflare.com/
* 按照以下步骤设置：


![0](img/depoly/cf/0.png)

---

![1](img/depoly/cf/1.png)

---

![2](img/depoly/cf/2.png)

---

![3](img/depoly/cf/3.png)

---

![4](img/depoly/cf/4.png)

---

![5](img/depoly/cf/5.png)

---

![6](img/depoly/cf/6.png)


> [!TIP]
> 如果你选择不开启安全密码，那么你可以转到 Website -> Security -> Bots -> 开启所有防护（Bot Fight Mode + Block AI bots）
