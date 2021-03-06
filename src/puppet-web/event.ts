/**
 *   Wechaty - https://github.com/chatie/wechaty
 *
 *   @copyright 2016-2017 Huan LI <zixia@zixia.net>
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */
import {
  WatchdogFood,
}                 from 'watchdog'

import {
  log,
}                 from '../config'
import Contact    from '../contact'
import {
  Message,
  MediaMessage,
}                 from '../message'
import {
  ScanInfo,
}                 from '../puppet'

import Firer      from './firer'
import PuppetWeb  from './puppet-web'
import {
  MsgType,
  MsgRawObj,
}                 from './schema'

/* tslint:disable:variable-name */
export const Event = {
  onLogin,
  onLogout,

  onDing,
  onScan,
  onLog,

  onMessage,
}

function onDing(this: PuppetWeb, data): void {
  log.silly('PuppetWebEvent', 'onDing(%s)', data)
  this.emit('watchdog', { data })
}

async function onScan(this: PuppetWeb, data: ScanInfo): Promise<void> {
  log.verbose('PuppetWebEvent', 'onScan(%d)', data && data.code)

  if (this.state.target() === 'dead') {
    log.verbose('PuppetWebEvent', 'onScan(%s) state.target=%s, NOOP',
                                  data, this.state.target())
    return
  }

  this.scanInfo = data

  /**
   * When wx.qq.com push a new QRCode to Scan, there will be cookie updates(?)
   */
  await this.saveCookie()

  if (this.user) {
    log.verbose('PuppetWebEvent', 'onScan() there has user when got a scan event. emit logout and set it to null')

    const bak = this.user || this.userId || ''
    this.user = this.userId = null
    this.emit('logout', bak)
  }

  // feed watchDog a `scan` type of food
  const food: WatchdogFood = {
    data,
    type: 'scan',
  }
  this.emit('watchdog', food)
  this.emit('scan'    , data.url, data.code)
}

function onLog(data: any): void {
  log.silly('PuppetWebEvent', 'onLog(%s)', data)
}

async function onLogin(this: PuppetWeb, memo: string, attempt = 0): Promise<void> {
  log.verbose('PuppetWebEvent', 'onLogin(%s, %d)', memo, attempt)

  if (this.state.target() === 'dead') {
    log.verbose('PuppetWebEvent', 'onLogin(%s, %d) state.target=%s, NOOP',
                                  memo, attempt, this.state.target())
    return
  }

  this.scanInfo = null

  if (this.userId) {
    log.warn('PuppetWebEvent', 'onLogin(%s) userId had already set: "%s"', memo, this.userId)
  }

  try {
    /**
     * save login user id to this.userId
     *
     * issue #772: this.bridge might not inited if the 'login' event fired too fast(because of auto login)
     */
    this.userId = await this.bridge.getUserName()

    if (!this.userId) {
      log.verbose('PuppetWebEvent', 'onLogin: browser not fully loaded(%d), retry later', attempt)
      setTimeout(onLogin.bind(this, memo, ++attempt), 100)
      return
    }

    log.silly('PuppetWebEvent', 'bridge.getUserName: %s', this.userId)
    this.user = Contact.load(this.userId)
    await this.user.ready()
    log.silly('PuppetWebEvent', `onLogin() user ${this.user.name()} logined`)

    try {
      if (this.state.target() === 'live' && this.state.stable()) {
        await this.saveCookie()
      }
    } catch (e) { // fail safe
      log.verbose('PuppetWebEvent', 'onLogin() this.saveCookie() exception: %s', e.message)
    }

    // fix issue #668
    try {
      await this.readyStable()
    } catch (e) { // fail safe
      log.warn('PuppetWebEvent', 'readyStable() exception: %s', e && e.message || e)
    }

    this.emit('login', this.user)

  } catch (e) {
    log.error('PuppetWebEvent', 'onLogin() exception: %s', e)
    throw e
  }

  return
}

function onLogout(this: PuppetWeb, data) {
  log.verbose('PuppetWebEvent', 'onLogout(%s)', data)

  if (!this.user && !this.userId) {
    log.warn('PuppetWebEvent', 'onLogout() without this.user or userId initialized')
  }

  const bak = this.user || this.userId || ''
  this.userId = this.user = null
  this.emit('logout', bak)
}

async function onMessage(this: PuppetWeb, obj: MsgRawObj): Promise<void> {
  let m = new Message(obj)

  try {
    await m.ready()

    /**
     * Fire Events if match message type & content
     */
    switch (m.type()) {

      case MsgType.VERIFYMSG:
        Firer.checkFriendRequest.call(this, m)
        break

      case MsgType.SYS:
        if (m.room()) {
          Firer.checkRoomJoin.call(this  , m)
          Firer.checkRoomLeave.call(this , m)
          Firer.checkRoomTopic.call(this , m)
        } else {
          Firer.checkFriendConfirm.call(this, m)
        }
        break
    }

    /**
     * Check Type for special Message
     * reload if needed
     */

    switch (m.type()) {
      case MsgType.EMOTICON:
      case MsgType.IMAGE:
      case MsgType.VIDEO:
      case MsgType.VOICE:
      case MsgType.MICROVIDEO:
      case MsgType.APP:
        log.verbose('PuppetWebEvent', 'onMessage() EMOTICON/IMAGE/VIDEO/VOICE/MICROVIDEO message')
        m = new MediaMessage(obj)
        break

      case MsgType.TEXT:
        if (m.typeSub() === MsgType.LOCATION) {
          log.verbose('PuppetWebEvent', 'onMessage() (TEXT&LOCATION) message')
          m = new MediaMessage(obj)
        }
        break
    }

    await m.ready()
    this.emit('message', m)

  } catch (e) {
    log.error('PuppetWebEvent', 'onMessage() exception: %s', e.stack)
    throw e
  }

  return
}

export default Event
