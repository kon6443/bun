#!/bin/bash
# Redis Swarm 서비스 생성/업데이트
# 사용법: 배포 서버에서 bash setup-redis.sh

SERVICE_NAME="sys_redis"
NETWORK="sys_default"
IMAGE="redis:7-alpine"

if docker service inspect $SERVICE_NAME > /dev/null 2>&1; then
  echo "[$SERVICE_NAME] 서비스 존재 → 업데이트"
  docker service update --image $IMAGE $SERVICE_NAME
else
  echo "[$SERVICE_NAME] 서비스 생성"
  docker service create \
    --name $SERVICE_NAME \
    --network $NETWORK \
    --replicas 1 \
    --restart-condition on-failure \
    --restart-max-attempts 5 \
    --health-cmd "redis-cli ping" \
    --health-interval 10s \
    --health-timeout 5s \
    --health-retries 3 \
    $IMAGE
fi

echo "상태 확인:"
docker service ps $SERVICE_NAME
