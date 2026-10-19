# 库存预留 HTTP 服务

启动入口由项目 README 给出，接受可配置的 localhost 端口及状态目录。库存初始数量为 10。无需身份系统，不依赖网络服务。

- STOCK-01：`GET /stock` 返回 JSON `available`，表示当前可用库存，成功状态为 200。
- STOCK-02：`POST /reserve` 接收 JSON `request_id` 和 `quantity`。request_id 为非空字符串，quantity 为 1 至 10 的整数；合法且库存充足时以 201 返回 `request_id,quantity,available`，库存恰好减少该数量。
- STOCK-03：同 request_id、同 quantity 的成功预留重试，返回 200 及首次预留的响应内容，不再次扣减。相同 request_id 换 quantity 返回 409，不改变库存。
- STOCK-04：库存不足返回 409，不扣减。并发不同 request_id 的请求不能使库存为负；成功扣减总数不得超过初始库存。并发同 request_id 不得重复扣减。
- STOCK-05：缺失必填字段、坏 JSON、非整数/超范围 quantity 返回 400，不改变状态。额外 JSON 字段的接受或拒绝均允许。
- STOCK-06：在一次成功 HTTP 响应返回后正常关闭再启动，库存及成功 request_id 的幂等记录必须保留；不同状态目录互不影响。
