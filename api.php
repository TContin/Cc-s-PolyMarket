<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$url = 'https://gamma-api.polymarket.com/markets?limit=30&active=true&closed=false&order=volume24hr&ascending=false';
$ctx = stream_context_create(['http' => ['timeout' => 8, 'header' => 'User-Agent: Mozilla/5.0']]);
$data = @file_get_contents($url, false, $ctx);
if ($data === false) {
    http_response_code(502);
    echo json_encode(['error' => 'upstream failed']);
} else {
    echo $data;
}
