> Historical design/reference notes: interfaces and upstream observations below are not a verified specification of the current plugin. See [current beta notes](issue-41-rebuild.md) and `src/cync/` for implementation behavior.

# **docs/cync-client-contract.md**

## **Cync Client Contract (TypeScript Implementation Outline)**

This document defines a platform-independent contract for a TypeScript Cync client. It serves as the foundation for integrating the Cync system into Homebridge.

The contract abstracts both the **cloud API layer** and the **TCP transport layer**.

---

## **1. Module Structure**

The client consists of two internal subsystems:

1. **ConfigClient**

   * Implements cloud authentication
   * Retrieves homes, rooms, and devices
   * Produces a structured configuration model

2. **TcpClient**

   * Opens the binary TCP session
   * Sends command frames
   * Receives device/room/sensor updates

A unifying `CyncClient` class composes these subsystems.

---

## **2. ConfigClient Interface**

```
interface ConfigClient {
  login(username: string, password: string): Promise<AuthResult>;
  submitTwoFactor(code: string): Promise<AuthResult>;

  getConfig(): Promise<CyncConfig>;
}
```

### **AuthResult**

```
interface AuthResult {
  authorized: boolean;
  twoFactorRequired?: boolean;
  userId?: string;
  accessToken?: string;
  authorizeToken?: string;
  loginCode?: Uint8Array;     // binary login sequence for TCP
}
```

### **CyncConfig**

```
interface CyncConfig {
  homes: CyncHome[];
  rooms: { [roomId: string]: CyncRoom };
  devices: { [deviceId: string]: CyncDevice };
  homeDevices: { [homeId: string]: { [meshIndex: number]: string } };
  homeControllers: { [homeId: string]: string[] };
  switchIdToHomeId: { [switchId: string]: string };
}
```

This structure mirrors the complete configuration returned by the upstream integration.

---

## **3. TcpClient Interface**

```
interface TcpClient {
  connect(loginCode: Uint8Array, config: CyncConfig): Promise<void>;
  disconnect(): Promise<void>;

  onDeviceUpdate(cb: (update: DeviceUpdate) => void): void;
  onRoomUpdate(cb: (update: RoomUpdate) => void): void;
  onMotionUpdate(cb: (update: MotionUpdate) => void): void;
  onAmbientUpdate(cb: (update: AmbientUpdate) => void): void;

  setSwitchState(deviceId: string, params: SwitchParams): Promise<void>;
}
```

### **Support Types**

```
interface DeviceUpdate {
  deviceId: string;
  on?: boolean;
  brightness?: number;
  colorTemp?: number;
  rgb?: { r: number; g: number; b: number };
}

interface RoomUpdate {
  roomId: string;
  state: any;                  // full room state payload
}

interface MotionUpdate {
  deviceId: string;
  motion: boolean;
}

interface AmbientUpdate {
  deviceId: string;
  lux: number;
}

interface SwitchParams {
  on?: boolean;
  brightness?: number;
  colorTemp?: number;
  rgb?: { r: number; g: number; b: number };
}
```

### **Behavior Requirements**

* Must open a TLS connection to `cm.gelighting.com:23779` (with fallbacks).
* Must send `loginCode` immediately after connection.
* Must parse incoming Cync binary frames.
* Must maintain keepalive frames.
* Must track pending commands using sequence numbers.
* Must resolve promises on acknowledgement or timeout.

---

## **4. Unified CyncClient Interface**

```
class CyncClient {
  constructor(configClient: ConfigClient, tcpClient: TcpClient);

  authenticate(username: string, password: string): Promise<AuthResult>;
  submitTwoFactor(code: string): Promise<AuthResult>;

  loadConfiguration(): Promise<CyncConfig>;

  startTransport(config: CyncConfig, loginCode: Uint8Array): Promise<void>;
  stopTransport(): Promise<void>;

  setSwitchState(deviceId: string, params: SwitchParams): Promise<void>;

  onDeviceUpdate(cb): void;
  onRoomUpdate(cb): void;
  onMotionUpdate(cb): void;
  onAmbientUpdate(cb): void;
}
```

The unified interface ensures that Homebridge only interacts with a single cohesive API, independent of cloud or TCP implementation details.

---

## **5. Scope of the Contract**

This contract provides the baseline functionality for:

* Plug control
* Light control (brightness, color temperature, RGB)
* Scene and group operations (room-level control)
* Sensor updates (motion, ambient light)
* Live state synchronization

This set of capabilities is sufficient for initial Homebridge platform support and can be extended incrementally.

---