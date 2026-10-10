#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
DLQ_ARN="arn:aws:sqs:${REGION}:000000000000:${DLQ_NAME}"

awslocal sqs create-queue --queue-name "$DLQ_NAME" \
  --attributes '{"FifoQueue":"true"}'

# maxReceiveCount é uma rede de segurança do broker; o consumer também limita tentativas.
awslocal sqs create-queue --queue-name "$QUEUE_NAME" \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# fila de saída: eventos publicados pelo outbox (consumidores externos)
awslocal sqs create-queue --queue-name "wager-events.fifo" \
  --attributes '{"FifoQueue":"true"}'

echo "SQS queues ready"
