# Scalability & High-Availability Roadmap

## 1. Stateless API Architecture
The Express backend is completely stateless:
- Authentication is stored in self-contained HS256 JWTs.
- Sessions are persisted in MongoDB.
- Multiple backend instances can run behind an AWS Application Load Balancer or NGINX reverse proxy with standard round-robin routing.

---

## 2. Database Scaling
- **Replica Sets**: MongoDB replica sets provide high availability and failover.
- **Sharding**: For large scale (> 100k active users), shard collections by `userId`.
- **Read Replicas**: Paginated audit log queries (`CreditLedger`, `LlmUsageLog`) can be directed to secondary read replicas.

---

## 3. Worker Scaling
- `TrialExpirationWorker` is currently an in-process cron. In a multi-instance production cluster, migrate this worker to **BullMQ** with Redis or AWS SQS to prevent redundant concurrent reconciliation runs across nodes.
