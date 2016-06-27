/* @flow */
/* global ErrorCat WorkerError DDTimer */
'use strict'

const cls = require('continuation-local-storage').createNamespace('ponos')
const clsBlueBird = require('cls-bluebird')
const defaults = require('101/defaults')
const errorCat = require('error-cat')
const exists = require('101/exists')
const isNumber = require('101/is-number')
const isObject = require('101/is-object')
const merge = require('101/put')
const monitor = require('monitor-dog')
const pick = require('101/pick')
const Promise = require('bluebird')
const uuid = require('uuid')
const WorkerStopError = require('error-cat/errors/worker-stop-error')

const TimeoutError = Promise.TimeoutError
clsBlueBird(cls)

/**
 * Performs tasks for jobs on a given queue.
 *
 * @author Bryan Kendall
 * @author Ryan Sandor Richards
 * @param {Object} opts Options for the worker.
 * @param {Function} opts.done Callback to execute when the job has successfully
 *   been completed.
 * @param {Object} opts.job Data for the job to process.
 * @param {String} opts.queue Name of the queue for the job the worker is
 *   processing.
 * @param {Function} opts.task A function to handle the tasks.
 * @param {ErrorCat} [opts.errorCat] An error-cat instance to use for the
 *   worker.
 * @param {bunyan} [opts.log] The bunyan logger to use when logging messages
 *   from the worker.
 * @param {number} [opts.msTimeout] A specific millisecond timeout for this
 *   worker.
 * @param {boolean} [opts.runNow] Whether or not to run the job immediately,
 *   defaults to `true`.
 */
class Worker {
  attempt: number;
  done: Function;
  errorCat: ErrorCat;
  job: Object;
  log: any;
  msTimeout: any;
  queue: String;
  retryDelay: number;
  task: Function;
  tid: String;

  constructor (opts: Object) {
    // managed required fields
    const fields = [
      'done',
      'job',
      'log',
      'queue',
      'task'
    ]
    fields.forEach(function (f) {
      if (!exists(opts[f])) {
        throw new Error(f + ' is required for a Worker')
      }
    })

    // manage field defaults
    fields.push('errorCat', 'log', 'msTimeout', 'runNow')
    opts = pick(opts, fields)
    defaults(opts, {
      // default non-required user options
      errorCat: errorCat,
      runNow: true,
      // other options
      attempt: 0,
      msTimeout: process.env.WORKER_TIMEOUT || 0,
      retryDelay: process.env.WORKER_MIN_RETRY_DELAY || 1
    })

    this.tid = opts.job.tid || uuid()
    opts.log = opts.log.child({ tid: this.tid, module: 'ponos:worker' })
    // put all opts on this
    Object.assign(this, opts)
    this.log.info({ queue: this.queue, job: this.job }, 'Worker created')

    // Ensure that the `msTimeout` option is valid
    this.msTimeout = parseInt(this.msTimeout, 10)
    if (!isNumber(this.msTimeout)) {
      throw new Error('Provided `msTimeout` is not an integer')
    }

    if (this.msTimeout < 0) {
      throw new Error('Provided `msTimeout` is negative')
    }

    if (this.runNow) {
      this.run()
    }
  }

  /**
   * Factory method for creating new workers. This method exists to make it
   * easier to unit test other modules that need to instantiate new workers.
   *
   * @see Worker
   * @param {Object} opts Options for the Worker.
   * @returns {Worker} New Worker.
   */
  static create (opts: Object): Worker {
    return new Worker(opts)
  }

  /**
   * Runs the worker. If the task for the job fails, then this method will retry
   * the task (with an exponential backoff) as set by the environment.
   *
   * @returns {Promise} Promise that is resolved once the task succeeds or
   *   fails.
   */
  run (): Promise<void> {
    this._incMonitor('ponos')
    const timer = this._createTimer()
    const log = this.log.child({
      method: 'run',
      queue: this.queue,
      job: this.job
    })

    return Promise.fromCallback((cb) => {
      cls.run(() => {
        cls.set('tid', this.tid)
        Promise.try(() => {
          const attemptData = {
            attempt: this.attempt++,
            timeout: this.msTimeout
          }
          log.info(attemptData, 'running task')
          let taskPromise = Promise.try(() => {
            return this.task(this.job)
          })

          if (this.msTimeout) {
            taskPromise = taskPromise.timeout(this.msTimeout)
          }
          return taskPromise
        }).asCallback(cb)
      })
    })
    .then((result) => {
      log.info({ result: result }, 'Task complete')
      this._incMonitor('ponos.finish', { result: 'success' })
      return this.done()
    })
    // if the type is TimeoutError, we will log and retry
    .catch(TimeoutError, (err) => {
      log.warn({ err: err }, 'Task timed out')
      this._incMonitor('ponos.finish', { result: 'timeout-error' })
      // by throwing this type of error, we will retry :)
      throw err
    })
    .catch((err) => {
      if (err.cause) {
        err = err.cause
      }
      if (!isObject(err.data)) {
        err.data = {}
      }
      if (!err.data.queue) {
        err.data.queue = this.queue
      }
      if (!err.data.job) {
        err.data.job = this.job
      }
      throw err
    })
    // if it's a WorkerStopError, we can't accomplish the task
    .catch(WorkerStopError, (err) => {
      log.error({ err: err }, 'Worker task fatally errored')
      this._incMonitor('ponos.finish', { result: 'fatal-error' })
      this._reportError(err)
      // If we encounter a fatal error we should no longer try to schedule
      // the job.
      return this.done()
    })
    .catch((err) => {
      const attemptData = {
        err: err,
        nextAttemptDelay: this.retryDelay
      }
      log.warn(attemptData, 'Task failed, retrying')
      this._incMonitor('ponos.finish', { result: 'task-error' })
      this._reportError(err)

      // Try again after a delay
      return Promise.delay(this.retryDelay)
        .then(() => {
          // Exponentially increase the retry delay
          const retryDelay = parseInt(process.env.WORKER_MAX_RETRY_DELAY) || 0
          if (this.retryDelay < retryDelay) {
            this.retryDelay *= 2
          }
          return this.run()
        })
    })
    .finally(() => {
      if (timer) {
        timer.stop()
      }
    })
  }

  // Private Methods

  /**
   * Helper function for reporting errors to rollbar via error-cat.
   *
   * @private
   * @param {Error} err Error to report.
   */
  _reportError (err: WorkerError): void {
    this.errorCat.report(err)
  }

  /**
   * Helper function for creating monitor-dog events tags. `queue` is the only
   * mandatory tag. Few tags will be created depending on the queue name. If
   * queueName use `.` as delimiter e.x. `10.0.0.20.api.github.push` then the
   * following tags will be created:
   * {
   *   token0: 'push'
   *   token1: 'github.push'
   *   token2: 'api.github.push'
   *   token3: '10.0.0.20.api.github.push'
   * }
   *
   * @private
   * @returns {Object} tags as Object { queue: 'docker.event.publish' }.
   */
  _eventTags (): Object {
    const tokens = this.queue.split('.').reverse()
    let lastToken = ''
    let tags = tokens.reduce((acc, currentValue, currentIndex) => {
      const key = 'token' + currentIndex
      const newToken = currentIndex === 0
        ? currentValue
        : currentValue + '.' + lastToken
      acc[key] = newToken
      lastToken = newToken
      return acc
    }, {})
    tags.queue = this.queue
    return tags
  }

  /**
   * Helper function calling `monitor.increment`. Monitor won't be called if
   * `WORKER_MONITOR_DISABLED` is set.
   *
   * @private
   * @param {String} eventName Name to be reported into the datadog.
   * @param {Object} [extraTags] Extra tags to be send with the event.
   */
  _incMonitor (eventName: string, extraTags?: Object): void {
    if (process.env.WORKER_MONITOR_DISABLED) {
      return
    }
    let tags = this._eventTags()
    if (extraTags) {
      tags = merge(tags, extraTags)
    }
    monitor.increment(eventName, tags)
  }

  /**
   * Helper function calling `monitor.timer`. Timer won't be created if
   * `WORKER_MONITOR_DISABLED` is set.
   *
   * @return {Object} New timer.
   * @private
   */
  _createTimer (): ?DDTimer {
    const tags = this._eventTags()
    return !process.env.WORKER_MONITOR_DISABLED
      ? monitor.timer('ponos.timer', true, tags)
      : null
  }
}

/**
 * Worker class.
 * @module ponos/lib/worker
 * @see Worker
 */
module.exports = Worker
