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

### 如果你选择粘贴 worker 代码，而不需要 connect to git 实现自动更新，那么恭喜你，只需要点击 `Start with Hello World!`，然后再点击 代码图标 `</>` ，把 `worker.js` 里面的内容粘贴进去就行了，无需后续步骤。

否则请继续按以下步骤操作。

![2](img/depoly/cf/2.png)

---

![3](img/depoly/cf/3.png)

---

### 到了这一步，你要先 [Fork （分叉）](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/fork-a-repo) 一份自己的储存库，因为 Coudflare 的 Worker 部署如果用 git repo 的话，（如果配置里面的 worker 程序名和 Cloudflare 里面写的不一样）它会给储存库添加一个分支。

---

![4](img/depoly/cf/4.png)

---

## 这里就是你可以访问的网址

![5](img/depoly/cf/5.png)

---

## 你也可以添加自定义域名

![6](img/depoly/cf/6.png)


> [!TIP]
> 如果你选择不开启安全密码，那么你可以转到 Website -> Security -> Bots -> 开启所有防护（Bot Fight Mode + Block AI bots）
