# FAQ

## 部署失败

* 请尝试关闭 Cloudflare URL 规范化（Normalization）[https://github.com/1234567Yang/cf-proxy-ex/issues/63#issuecomment-3920749992]
![URL Normalization](img/depoly/faq_url_normalization.png)

* 请尝试完全复制粘贴 `_worker.js` 的内容，如果还是不行请删除 worker 并新建一个。
