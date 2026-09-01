// Self-contained Backend Wire v1 fixture used by the packaged Plans bridge
// conformance gate. This file intentionally uses only the Go standard library
// and is built directly into dist-test-fixtures; it is not a production plugin.
package main

import (
	"bufio"
	"bytes"
	cryptorand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const protocolRevision = "2026-07-28"
const serverInfoKey = "io.modelcontextprotocol/serverInfo"
const subscriptionIDKey = "io.modelcontextprotocol/subscriptionId"
const eventFilterKey = "dev.navide/pluginEvents"
const maxFrameBytes = 1_048_576

var serverInfo = map[string]any{"name": "navide.plans", "version": "0.1.92"}

type bridgeFailure struct{ code string }

func (e bridgeFailure) Error() string { return e.code }

type subscription struct {
	id            any
	events        []string
	watchStarted  bool
	workspacePath string
}

type bridgeResponse struct {
	kind  string
	value any
}

var state = struct {
	sync.Mutex
	delays             map[string]chan struct{}
	delayIntents       map[string]struct{}
	preCancelledDelays map[string]struct{}
	subscriptions      map[string]*subscription
	bridgePending      map[string]chan bridgeResponse
	bridgeByOrigin     map[string]map[string]struct{}
	cancelledCount     int
	closing            bool
}{
	delays:             map[string]chan struct{}{},
	delayIntents:       map[string]struct{}{},
	preCancelledDelays: map[string]struct{}{},
	subscriptions:      map[string]*subscription{},
	bridgePending:      map[string]chan bridgeResponse{},
	bridgeByOrigin:     map[string]map[string]struct{}{},
}

var writeMu sync.Mutex

func writeFrame(frame any) error {
	encoded, err := json.Marshal(frame)
	if err != nil || bytes.IndexByte(encoded, '\r') >= 0 || bytes.IndexByte(encoded, '\n') >= 0 {
		return errors.New("invalid output frame")
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	_, err = os.Stdout.Write(append(encoded, '\n'))
	return err
}

func writeRaw(encoded string) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	_, err := io.WriteString(os.Stdout, encoded)
	return err
}

func isRecord(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok
}

func exactKeys(value any, keys ...string) bool {
	record, ok := isRecord(value)
	if !ok || len(record) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, present := record[key]; !present {
			return false
		}
	}
	return true
}

func requestID(value any) (any, bool) {
	switch typed := value.(type) {
	case string:
		return typed, typed != ""
	case json.Number:
		if strings.ContainsAny(string(typed), ".eE") {
			return nil, false
		}
		return typed, true
	default:
		return nil, false
	}
}

func stringValue(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok && text != ""
}

func methodName(value any) bool {
	text, ok := value.(string)
	if !ok || text == "" {
		return false
	}
	segmentStart := true
	for _, character := range text {
		if segmentStart {
			if character < 'a' || character > 'z' {
				return false
			}
			segmentStart = false
			continue
		}
		if character == '.' {
			segmentStart = true
			continue
		}
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_' {
			continue
		}
		return false
	}
	return !segmentStart
}

func jsonValue(value any) bool {
	switch typed := value.(type) {
	case nil, bool, string:
		return true
	case json.Number:
		number, err := strconv.ParseFloat(string(typed), 64)
		return err == nil && !math.IsNaN(number) && !math.IsInf(number, 0)
	case []any:
		for _, item := range typed {
			if !jsonValue(item) {
				return false
			}
		}
		return true
	case map[string]any:
		for _, item := range typed {
			if !jsonValue(item) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func compactJSON(line []byte) bool {
	inString := false
	escaped := false
	for _, character := range line {
		if inString {
			if escaped {
				escaped = false
			} else if character == '\\' {
				escaped = true
			} else if character == '"' {
				inString = false
			}
			continue
		}
		if character == '"' {
			inString = true
		} else if character == ' ' || character == '\t' || character == '\r' || character == '\n' {
			return false
		}
	}
	return !inString && !escaped
}

func decodeValue(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch delimiter := token.(type) {
	case json.Delim:
		switch delimiter {
		case '{':
			object := map[string]any{}
			for dec.More() {
				keyToken, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("object key is not a string")
				}
				if _, duplicate := object[key]; duplicate {
					return nil, errors.New("duplicate object key")
				}
				value, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				object[key] = value
			}
			end, err := dec.Token()
			if err != nil || end != json.Delim('}') {
				return nil, errors.New("invalid object")
			}
			return object, nil
		case '[':
			array := []any{}
			for dec.More() {
				value, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				array = append(array, value)
			}
			end, err := dec.Token()
			if err != nil || end != json.Delim(']') {
				return nil, errors.New("invalid array")
			}
			return array, nil
		default:
			return nil, errors.New("invalid delimiter")
		}
	default:
		return token, nil
	}
}

func parseStrict(line []byte) (any, error) {
	if len(line) == 0 || len(line) > maxFrameBytes || bytes.HasPrefix(line, []byte{0xef, 0xbb, 0xbf}) || !compactJSON(line) {
		return nil, errors.New("invalid frame")
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	value, err := decodeValue(decoder)
	if err != nil || !jsonValue(value) {
		return nil, errors.New("invalid JSON")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing JSON")
	}
	return value, nil
}

func originKey(origin map[string]any) string {
	return fmt.Sprintf("%s:%T:%v", origin["kind"], origin["requestId"], origin["requestId"])
}

func validOrigin(value any) (map[string]any, bool) {
	origin, ok := isRecord(value)
	if !ok || !exactKeys(origin, "kind", "requestId") || (origin["kind"] != "call" && origin["kind"] != "subscription") {
		return nil, false
	}
	_, ok = requestID(origin["requestId"])
	return origin, ok
}

func bridgeCall(origin map[string]any, port string, operation string, arguments any) (any, error) {
	bridgeID := "bridge:" + randomID()
	responseChannel := make(chan bridgeResponse, 1)
	key := originKey(origin)
	state.Lock()
	state.bridgePending[bridgeID] = responseChannel
	if state.bridgeByOrigin[key] == nil {
		state.bridgeByOrigin[key] = map[string]struct{}{}
	}
	state.bridgeByOrigin[key][bridgeID] = struct{}{}
	state.Unlock()
	defer func() {
		state.Lock()
		delete(state.bridgePending, bridgeID)
		ids := state.bridgeByOrigin[key]
		delete(ids, bridgeID)
		if len(ids) == 0 {
			delete(state.bridgeByOrigin, key)
		}
		state.Unlock()
	}()

	if err := writeFrame(map[string]any{
		"jsonrpc": "2.0",
		"id":      bridgeID,
		"method":  "navide/host/call",
		"params": map[string]any{
			"origin":    map[string]any{"kind": origin["kind"], "requestId": origin["requestId"]},
			"port":      port,
			"operation": operation,
			"arguments": arguments,
		},
	}); err != nil {
		return nil, bridgeFailure{"BACKEND_UNAVAILABLE"}
	}
	for {
		select {
		case response := <-responseChannel:
			if response.kind == "error" {
				return nil, bridgeFailure{fmt.Sprint(response.value)}
			}
			return response.value, nil
		case <-time.After(250 * time.Millisecond):
			state.Lock()
			closing := state.closing
			state.Unlock()
			if closing {
				return nil, bridgeFailure{"BACKEND_UNAVAILABLE"}
			}
		}
	}
}

func handleBridgeResult(frame map[string]any) bool {
	bridgeID, ok := frame["id"].(string)
	if !ok || !strings.HasPrefix(bridgeID, "bridge:") || len(bridgeID) == len("bridge:") {
		return false
	}
	state.Lock()
	responseChannel := state.bridgePending[bridgeID]
	state.Unlock()
	if responseChannel == nil {
		return true
	}
	if result, ok := frame["result"].(map[string]any); ok && frame["jsonrpc"] == "2.0" && result["resultType"] == "complete" {
		responseChannel <- bridgeResponse{kind: "result", value: result["value"]}
		return true
	}
	if errorValue, ok := frame["error"].(map[string]any); ok {
		code := "BACKEND_UNAVAILABLE"
		if data, ok := errorValue["data"].(map[string]any); ok {
			if value, ok := data["code"].(string); ok {
				code = value
			}
		}
		responseChannel <- bridgeResponse{kind: "error", value: code}
		return true
	}
	responseChannel <- bridgeResponse{kind: "error", value: "PROTOCOL_ERROR"}
	return true
}

func handleBridgeEvent(frame map[string]any) (bool, error) {
	if frame["method"] != "navide/host/event" {
		return false, nil
	}
	params, ok := frame["params"].(map[string]any)
	if frame["jsonrpc"] != "2.0" || !ok || !exactKeys(params, "origin", "event", "payload") || !methodName(params["event"]) || !jsonValue(params["payload"]) {
		return true, errors.New("invalid Host event")
	}
	origin, ok := validOrigin(params["origin"])
	if !ok {
		return true, errors.New("invalid Host origin")
	}
	if origin["kind"] == "subscription" && params["event"] == "filesystem.changed" {
		emitEvent("plans.changed", params["payload"], origin["requestId"])
	}
	return true, nil
}

func cancelBridge(bridgeID string, code string) {
	state.Lock()
	responseChannel := state.bridgePending[bridgeID]
	state.Unlock()
	if responseChannel != nil {
		select {
		case responseChannel <- bridgeResponse{kind: "error", value: code}:
		default:
		}
	}
}

func cancelBridgeForOrigin(origin map[string]any) {
	key := originKey(origin)
	state.Lock()
	ids := make([]string, 0, len(state.bridgeByOrigin[key]))
	for bridgeID := range state.bridgeByOrigin[key] {
		ids = append(ids, bridgeID)
	}
	state.Unlock()
	for _, bridgeID := range ids {
		cancelBridge(bridgeID, "USER_CANCELLED")
		_ = writeFrame(map[string]any{
			"jsonrpc": "2.0",
			"method":  "notifications/cancelled",
			"params":  map[string]any{"requestId": bridgeID, "reason": "cancelled"},
		})
	}
}

func randomID() string {
	bytes := make([]byte, 16)
	if _, err := cryptorand.Read(bytes); err == nil {
		return fmt.Sprintf("%x", bytes)
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func response(requestID any, value any, subscriptionID any, includeSubscription bool) {
	metadata := map[string]any{serverInfoKey: serverInfo}
	if includeSubscription {
		metadata[subscriptionIDKey] = subscriptionID
	}
	result := map[string]any{"resultType": "complete", "_meta": metadata}
	if value != nil {
		result["value"] = value
	}
	_ = writeFrame(map[string]any{"jsonrpc": "2.0", "id": requestID, "result": result})
}

func pluginError(requestID any, code string) {
	_ = writeFrame(map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID,
		"error":   map[string]any{"code": 1000, "message": "Plugin request failed", "data": map[string]any{"code": code}},
	})
}

func protocolError(requestID any, hasID bool) {
	frame := map[string]any{"jsonrpc": "2.0", "error": map[string]any{"code": -32600, "message": "Invalid request"}}
	if hasID {
		frame["id"] = requestID
	}
	_ = writeFrame(frame)
}

func emitEvent(event string, payload any, targetSubscriptionID ...any) {
	state.Lock()
	subscriptions := make([]*subscription, 0, len(state.subscriptions))
	for _, value := range state.subscriptions {
		if len(targetSubscriptionID) > 0 && value.id != targetSubscriptionID[0] {
			continue
		}
		for _, accepted := range value.events {
			if accepted == event {
				subscriptions = append(subscriptions, value)
				break
			}
		}
	}
	state.Unlock()
	for _, value := range subscriptions {
		_ = writeFrame(map[string]any{
			"jsonrpc": "2.0",
			"method":  "notifications/navide/event",
			"params": map[string]any{
				"_meta":   map[string]any{subscriptionIDKey: value.id},
				"event":   event,
				"payload": payload,
			},
		})
	}
}

func selectedSubscription(arguments any) *subscription {
	values, _ := arguments.(map[string]any)
	requestedID, requested := values["subscriptionId"]
	state.Lock()
	defer state.Unlock()
	if requested {
		return state.subscriptions[fmt.Sprint(requestedID)]
	}
	for _, value := range state.subscriptions {
		return value
	}
	return nil
}

func startWatchers(root string) {
	state.Lock()
	watchers := []*subscription{}
	for _, value := range state.subscriptions {
		accepted := false
		for _, event := range value.events {
			if event == "plans.changed" {
				accepted = true
				break
			}
		}
		if accepted && !value.watchStarted {
			value.watchStarted = true
			value.workspacePath = root
			watchers = append(watchers, value)
		}
	}
	state.Unlock()
	for _, value := range watchers {
		go func(subscriptionValue *subscription) {
			_, err := bridgeCall(
				map[string]any{"kind": "subscription", "requestId": subscriptionValue.id},
				"filesystem",
				"watch",
				map[string]any{"rel_path": ""},
			)
			if err == nil {
				return
			}
			state.Lock()
			current := state.subscriptions[fmt.Sprint(subscriptionValue.id)]
			delete(state.subscriptions, fmt.Sprint(subscriptionValue.id))
			state.Unlock()
			if current != nil {
				response(current.id, nil, current.id, true)
			}
		}(value)
	}
}

func handleCancellation(frame map[string]any) bool {
	if frame["method"] != "notifications/cancelled" || frame["jsonrpc"] != "2.0" {
		return false
	}
	params, ok := frame["params"].(map[string]any)
	if !ok || (!exactKeys(params, "requestId") && !exactKeys(params, "requestId", "reason")) {
		protocolError(nil, false)
		return true
	}
	id, ok := requestID(params["requestId"])
	if !ok {
		protocolError(nil, false)
		return true
	}
	if bridgeID, ok := id.(string); ok && strings.HasPrefix(bridgeID, "bridge:") {
		cancelBridge(bridgeID, "USER_CANCELLED")
		return true
	}
	key := fmt.Sprint(id)
	state.Lock()
	if cancel, present := state.delays[key]; present {
		close(cancel)
		delete(state.delays, key)
		state.cancelledCount++
	} else if _, present := state.delayIntents[key]; present {
		delete(state.delayIntents, key)
		state.preCancelledDelays[key] = struct{}{}
		state.cancelledCount++
	}
	if _, present := state.subscriptions[key]; present {
		delete(state.subscriptions, key)
		state.cancelledCount++
	}
	state.Unlock()
	cancelBridgeForOrigin(map[string]any{"kind": "call", "requestId": id})
	cancelBridgeForOrigin(map[string]any{"kind": "subscription", "requestId": id})
	return true
}

func validRequest(frame map[string]any, method string, parameterKeys ...string) bool {
	if !exactKeys(frame, "jsonrpc", "id", "method", "params") || frame["jsonrpc"] != "2.0" || frame["method"] != method {
		return false
	}
	if _, ok := requestID(frame["id"]); !ok {
		return false
	}
	params, ok := frame["params"].(map[string]any)
	if !ok || !exactKeys(params, parameterKeys...) {
		return false
	}
	meta, ok := params["_meta"].(map[string]any)
	return ok && meta["io.modelcontextprotocol/protocolVersion"] == protocolRevision && meta["io.modelcontextprotocol/clientCapabilities"] != nil
}

func handle(frame any) {
	record, ok := isRecord(frame)
	if !ok {
		protocolError(nil, false)
		return
	}
	if handleBridgeResult(record) {
		return
	}
	if handled, err := handleBridgeEvent(record); handled {
		if err != nil {
			state.Lock()
			state.closing = true
			state.Unlock()
		}
		return
	}
	if handleCancellation(record) {
		return
	}
	if validRequest(record, "navide/health", "_meta") {
		meta := record["params"].(map[string]any)["_meta"].(map[string]any)
		response(record["id"], map[string]any{
			"method":             "navide/health",
			"protocolVersion":    meta["io.modelcontextprotocol/protocolVersion"],
			"requestIdIsNonNull": record["id"] != nil,
			"clientCapabilities": meta["io.modelcontextprotocol/clientCapabilities"],
		}, nil, false)
		return
	}
	if validRequest(record, "subscriptions/listen", "_meta", "notifications", "runtime") {
		params := record["params"].(map[string]any)
		notifications, notificationsOK := params["notifications"].(map[string]any)
		events, eventsOK := notifications[eventFilterKey].([]any)
		if !notificationsOK || !eventsOK || len(events) == 0 || !validRuntime(params["runtime"]) {
			protocolError(record["id"], true)
			return
		}
		accepted := make([]string, 0, len(events))
		for _, event := range events {
			name, ok := event.(string)
			if !ok || !methodName(name) {
				protocolError(record["id"], true)
				return
			}
			accepted = append(accepted, name)
		}
		value := &subscription{id: record["id"], events: accepted}
		state.Lock()
		state.subscriptions[fmt.Sprint(record["id"])] = value
		state.Unlock()
		_ = writeFrame(map[string]any{
			"jsonrpc": "2.0",
			"method":  "notifications/subscriptions/acknowledged",
			"params": map[string]any{
				"_meta":         map[string]any{subscriptionIDKey: record["id"]},
				"notifications": map[string]any{eventFilterKey: accepted},
			},
		})
		return
	}
	if !validRequest(record, "navide/call", "_meta", "name", "arguments", "runtime") {
		protocolError(record["id"], record["id"] != nil)
		return
	}
	params := record["params"].(map[string]any)
	if params["name"] == "fixture.delay" {
		state.Lock()
		state.delayIntents[fmt.Sprint(record["id"])] = struct{}{}
		state.Unlock()
	}
	go handleCall(record)
}

func validRuntime(value any) bool {
	runtime, ok := isRecord(value)
	if !ok || len(runtime) != 7 {
		return false
	}
	for _, key := range []string{"pluginId", "packageVersion", "workspaceId", "instanceId", "contributionKey", "hostWindowId", "initiator"} {
		value, present := runtime[key]
		if !present {
			return false
		}
		if key == "pluginId" || key == "packageVersion" {
			if text, ok := value.(string); !ok || text == "" {
				return false
			}
		} else if key == "initiator" {
			if !validInitiator(value) {
				return false
			}
		} else if value != nil {
			if _, ok := value.(string); !ok {
				return false
			}
		}
	}
	return true
}

func validInitiator(value any) bool {
	initiator, ok := isRecord(value)
	if !ok {
		return false
	}
	kind, _ := initiator["kind"].(string)
	id, idOK := initiator["id"].(string)
	if kind == "user" {
		return len(initiator) == 2 && idOK && id != ""
	}
	source, sourceOK := initiator["source"].(string)
	return kind == "agent" && source == "mcp" && sourceOK && len(initiator) == 3 && idOK && id != ""
}

func handleCall(frame map[string]any) {
	params := frame["params"].(map[string]any)
	name, nameOK := params["name"].(string)
	arguments := params["arguments"]
	if !nameOK || !methodName(name) || !jsonValue(arguments) || !validRuntime(params["runtime"]) {
		protocolError(frame["id"], true)
		return
	}
	if name == "plans.resolve_root" {
		values, ok := arguments.(map[string]any)
		workspacePath, pathOK := values["workspace_path"].(string)
		if !ok || !pathOK || workspacePath == "" {
			protocolError(frame["id"], true)
			return
		}
		rootValue, err := bridgeCall(map[string]any{"kind": "call", "requestId": frame["id"]}, "filesystem", "resolve_root", map[string]any{})
		if err != nil {
			pluginError(frame["id"], bridgeCode(err))
			return
		}
		rootRecord, ok := rootValue.(map[string]any)
		root, rootOK := rootRecord["root"].(string)
		if !ok || !rootOK {
			pluginError(frame["id"], "PROTOCOL_ERROR")
			return
		}
		response(frame["id"], map[string]any{"ok": true, "root": root}, nil, false)
		emitEvent("plans.changed", map[string]any{"workspace_path": root})
		startWatchers(root)
		return
	}
	switch name {
	case "fixture.echo":
		response(frame["id"], map[string]any{"arguments": arguments, "runtime": params["runtime"]}, nil, false)
	case "fixture.cancelcount":
		state.Lock()
		count := state.cancelledCount
		state.Unlock()
		response(frame["id"], count, nil, false)
	case "fixture.delay":
		values, _ := arguments.(map[string]any)
		milliseconds := int64(100)
		if number, ok := values["milliseconds"].(json.Number); ok {
			fmt.Sscan(string(number), &milliseconds)
		}
		cancel := make(chan struct{})
		key := fmt.Sprint(frame["id"])
		state.Lock()
		delete(state.delayIntents, key)
		if _, cancelled := state.preCancelledDelays[key]; cancelled {
			delete(state.preCancelledDelays, key)
			state.Unlock()
			return
		}
		state.delays[key] = cancel
		state.Unlock()
		go func() {
			select {
			case <-time.After(time.Duration(milliseconds) * time.Millisecond):
				state.Lock()
				delete(state.delays, key)
				closing := state.closing
				state.Unlock()
				if !closing {
					response(frame["id"], map[string]any{"delayed": true}, nil, false)
				}
			case <-cancel:
			}
		}()
	case "fixture.emit":
		values, ok := arguments.(map[string]any)
		if !ok || !methodName(values["event"]) || !jsonValue(values["payload"]) {
			protocolError(frame["id"], true)
			return
		}
		target := selectedSubscription(arguments)
		if target == nil {
			protocolError(frame["id"], true)
			return
		}
		emitEvent(values["event"].(string), values["payload"], target.id)
		response(frame["id"], map[string]any{"ok": true}, nil, false)
	case "fixture.progress":
		values, _ := arguments.(map[string]any)
		requestedID, requested := values["subscriptionId"]
		state.Lock()
		var target *subscription
		if requested {
			target = state.subscriptions[fmt.Sprint(requestedID)]
		} else {
			for _, candidate := range state.subscriptions {
				target = candidate
				break
			}
		}
		state.Unlock()
		if target == nil {
			protocolError(frame["id"], true)
			return
		}
		_ = writeFrame(map[string]any{
			"jsonrpc": "2.0",
			"method":  "notifications/progress",
			"params": map[string]any{
				"progressToken": target.id,
				"progress":      1,
				"total":         2,
				"message":       "fixture progress",
			},
		})
		response(frame["id"], map[string]any{"ok": true}, nil, false)
	case "fixture.forgedevent":
		values, _ := arguments.(map[string]any)
		requestedID, requested := values["subscriptionId"]
		if !requested {
			requestedID = "forged-subscription"
		}
		emitEvent("fixture.changed", map[string]any{"forged": true}, requestedID)
		response(frame["id"], map[string]any{"ok": true}, nil, false)
	case "fixture.duplicateevent":
		target := selectedSubscription(nil)
		subscriptionID := "\"forged-subscription\""
		if target != nil {
			encoded, err := json.Marshal(target.id)
			if err == nil {
				subscriptionID = string(encoded)
			}
		}
		_ = writeRaw(
			`{"jsonrpc":"2.0","method":"notifications/navide/event","params":{"_meta":{"` +
				subscriptionIDKey + `":` + subscriptionID + `,"` + subscriptionIDKey + `":` + subscriptionID +
				`},"event":"fixture.changed","payload":{}}}` + "\n",
		)
	case "fixture.unknownnotification":
		_ = writeFrame(map[string]any{"jsonrpc": "2.0", "method": "notifications/unknown", "params": map[string]any{}})
	case "fixture.lateresponse":
		values, _ := arguments.(map[string]any)
		requestID, ok := values["requestId"]
		if !ok {
			protocolError(frame["id"], true)
			return
		}
		response(requestID, map[string]any{"late": true}, nil, false)
		response(frame["id"], map[string]any{"ok": true}, nil, false)
	case "fixture.close":
		value := selectedSubscription(arguments)
		state.Lock()
		if value != nil {
			delete(state.subscriptions, fmt.Sprint(value.id))
		}
		state.Unlock()
		if value == nil {
			protocolError(frame["id"], true)
			return
		}
		response(value.id, nil, value.id, true)
		response(frame["id"], map[string]any{"ok": true}, nil, false)
	case "fixture.exit":
		os.Exit(17)
	case "fixture.stderr":
		_, _ = fmt.Fprintln(os.Stderr, "fixture diagnostic: /private/internal/path")
		response(frame["id"], map[string]any{"ok": true}, nil, false)
	case "fixture.publicerror":
		pluginError(frame["id"], "INVALID_ARGUMENT")
	case "fixture.protocolerror":
		_ = writeFrame(map[string]any{
			"jsonrpc": "2.0",
			"id":      frame["id"],
			"error":   map[string]any{"code": -32601, "message": "Method not found"},
		})
	case "fixture.badversion":
		_ = writeFrame(map[string]any{
			"jsonrpc": "2.1",
			"id":      frame["id"],
			"result": map[string]any{
				"resultType": "complete",
				"value":      true,
				"_meta":      map[string]any{serverInfoKey: serverInfo},
			},
		})
	case "fixture.duplicatekeys":
		encodedID, _ := json.Marshal(frame["id"])
		_ = writeRaw(
			`{"jsonrpc":"2.0","id":` + string(encodedID) + `,"result":{"resultType":"complete","value":true,"_meta":{"` +
				serverInfoKey + `":{"name":"navide.plans","version":"0.1.92"}}},"result":{}}` + "\n",
		)
	case "fixture.multiline":
		_ = writeRaw(`{"jsonrpc":"2.0",` + "\n")
		_ = writeRaw(`"id":` + fmt.Sprint(frame["id"]) + `,"result":{"resultType":"complete","value":true,"_meta":{"` +
			serverInfoKey + `":{"name":"navide.plans","version":"0.1.92"}}}}` + "\n")
	case "fixture.unknownmethod":
		_ = writeFrame(map[string]any{"jsonrpc": "2.0", "id": frame["id"], "method": "tools/list", "params": map[string]any{}})
	case "fixture.forgedruntime":
		_ = writeFrame(map[string]any{
			"jsonrpc": "2.0",
			"id":      frame["id"],
			"runtime": map[string]any{"pluginId": "forged.plugin"},
			"result": map[string]any{
				"resultType": "complete",
				"value":      true,
				"_meta":      map[string]any{serverInfoKey: serverInfo},
			},
		})
	case "fixture.spawn_transform":
		values, ok := arguments.(map[string]any)
		if !ok || values["command"] == nil {
			pluginError(frame["id"], "INVALID_ARGUMENT")
			return
		}
		response(frame["id"], map[string]any{"command": values["command"], "allowed": true}, nil, false)
	case "fixture.stream":
		values, ok := arguments.(map[string]any)
		if !ok || values["chunk_base64"] == nil {
			pluginError(frame["id"], "INVALID_ARGUMENT")
			return
		}
		chunk, err := base64.StdEncoding.DecodeString(fmt.Sprint(values["chunk_base64"]))
		if err != nil || len(chunk) > 64*1024 {
			pluginError(frame["id"], "RESOURCE_LIMIT")
			return
		}
		response(frame["id"], map[string]any{"accepted_bytes": len(chunk)}, nil, false)
	default:
		_ = writeFrame(map[string]any{"jsonrpc": "2.0", "id": frame["id"], "error": map[string]any{"code": -32601, "message": "Method not found"}})
	}
}

func bridgeCode(err error) string {
	var failure bridgeFailure
	if errors.As(err, &failure) {
		return failure.code
	}
	return "BACKEND_UNAVAILABLE"
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), maxFrameBytes+1)
	for scanner.Scan() {
		line := scanner.Bytes()
		frame, err := parseStrict(line)
		if err != nil {
			state.Lock()
			state.closing = true
			state.Unlock()
			os.Exit(2)
		}
		handle(frame)
	}
	state.Lock()
	state.closing = true
	state.Unlock()
	if scanner.Err() != nil {
		os.Exit(2)
	}
}
